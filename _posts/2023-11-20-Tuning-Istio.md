---
layout: single
categories: istio
date:  2023-11-20 19:00:00 +0800
author: Yangyang Zhao
---

Some of the new users of service mesh solutions including myself may think that network connections would be **improved** by just introducing the solution. This is wrong!


In fact, ever since introducing Istio, we've met more way networking issues with workloads enabled service mesh, compared to the workloads that doesn't. There are many of the cases you might be supprised that you need to take care of once you start to use Istio.

In this blog post, we will see how Istio makes things more complicated, and how we could tune the Istio setting to improve the networking connections.

## istio-proxy

istio-proxy, is like the wheels of the Pod, it hijacks all the network connections from/to the Pod after initialization.  

Before you adapt Istio, your client Pod and server Pod would be connected via a single TCP connection, when you experienced some networking issues, you would either find some evidence from client side or server side. You only have 2 places to look at.

<img src="{{site.url}}/assets/imgs/04-direct-connection.svg"
     alt="Istio Proxy"
     style="display: block; width: 70%; margin: auto; background: white;" />

After you adapt Istio, both your client Pod and server Pod will be injected with an `istio-proxy` container, and this container hijacks all TCP connections in / out of the Pod.


<img src="{{site.url}}/assets/imgs/04-istio-proxy.svg"
     alt="Istio Proxy"
     style="display: block; width: 70%; margin: auto; background: white;" />

So instead of 1 TCP connection, you will have to establish 3 TCP connections to "simulate" the original 1 TCP connection:
1. Between client Pod' main container and its istio-proxy container
2. Between client Pod's istio-proxy container and server Pod's istio-proxy container
3. Between server Pod's istio-proxy container and server Pod's main container

 Supppose 1 TCP connection have 99.999% SLA, with istio enabled, you will have your 5 9's SLA degraded to 4 9s. (99.999%<sup>3</sup> = 99.997%) natually. And what's more, there are pitfalls around its life cycles.

### Startup network availability 

One of the problems when met in early days with istio is the startup networking issue - in client Pod's main container, our application launches and tries to access the network immediately. 


<img src="{{site.url}}/assets/imgs/04-istio-proxy-start.svg"
     alt="Istio Proxy"
     style="display: block; width: 70%; margin: auto; background: white;" />


While `istio-proxy` works as a "sidecar" container, it is launched with the main container together. As a matter of fact, there is no "main" or "sidecar" concept in Kubernetes (there is a [proposal](https://github.com/kubernetes/enhancements/issues/753) in k8s but not procceeded yet.), both of them are containers. But if `istio-proxy` container is not ready, all the other containers in the Pod will not be able to access network. And if you main container happen to start network access earlier than `istio-proxy` container ready, your main container may fail to start.

Most of the ppl didn't realie this start up gap, the main container's process is not able to access network in the begining, and it may retry and eventually succeeded after istio-proxy is ready; Or they exit with non-zero command and the main container get restarted, evetually it will also succeed after istio-proxy is ready.

Sometimes your application start is expensive and may have side effect, so you do not want the main container to be restarted. To mitigate this issue, we've added wrapper script to the main container to monitor the `istio-proxy` container's readiness (exposed in port 15000) before it really start the final command. 

```bash
# Wait for istio sidecar starts
waited=0
while true; do
   curl --max-time 1 --head localhost:15000 >> /dev/null && break
   waited=$((waited+1))
   echo "Wait 1s for istio sidecar"
   sleep 1
done
echo "Istio sidecar is ready after ${waited} seconds wait"

# Start real process
```

The Istio team is aware of this issue, therefore from Istio 1.8+, a proxy config can be enabled to hold application container to start until `istio-proxy` is ready.


```yaml
apiVersion: install.istio.io/v1alpha2
kind: IstioOperator
spec:
  meshConfig:
    defaultConfig:
      holdApplicationUntilProxyStarts: true
```

Some prodution practise shows that even if `holdApplicationUntilProxyStarts` was introduced, the very first short time of the main container might still suffer from network issues, so if your app is very sensitive to network access in the startup phase, you may need to take care of the start process.


### Graceful Termination


Since `istio-proxy`  plays as a "proxy", in order to make sure your main container have 100% of network connectivity, you need to make sure `istio-proxy`'s availability is longer than your main container's network availibility. That is, before your container start network access, istio-proxy needs to be ready, and it must be ready after your container drops the network.

Networking issues also happens during the termination of the Pod. When a Pod is to be terminated, Kubernetes send `SIGTERM` to each of the Pod's container, including your main container, and `istio-proxy` container. 

As a kubernetes user, you might already be familiar with the [termination in Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#pod-termination), so your application already handles `SIGTERM` in a graceful way - it first blocks any new connetions, and then finishes the existing connections' requests, finally shutdown itself. At the same time we also configure `spec.terminationGracePeriodSeconds` to give the main container's process time for processing the exisiting requests.


Howeve, the problem is that by default, `istio-proxy` container will "immediately" falls in to the shutdown process, and draining all the connactions it currently holds. So all of a sudden, your main container loses all network access, either inbound or outbound. This makes your Pod's graceful shutdown not working anymore.

<img src="{{site.url}}/assets/imgs/04-istio-proxy-terminate.svg"
     alt="Istio Proxy"
     style="display: block; width: 70%; margin: auto; background: white;" />

We've experienced this problem that when HorizontalPodAutoscaler scales down the server Deployment, there will be a lot of 503 client errors complaining about connetion failure.

In order to solve this problem, Istio provides configuration hold the `istio-proxy` for given duration before draining all the connections, similar to `holdApplicationUntilProxyStarts`, it can be configured in the global isito settings.

```yaml
apiVersion: install.istio.io/v1alpha2
kind: IstioOperator
spec:
  meshConfig:
    defaultConfig:
      terminationDrainDuration: 30s
```

Although, I recommend you to adapt this setting per deployment because every deployment may have different patterns of graceful and different time duration needed.

```yaml
metadata:
    annotations:
    proxy.istio.io/config: |
        terminationDrainDuration: 30s
```

The above annotation can be added in Pod spec so that it overrides' the global settings, usually this should match the `spec.terminationGracePeriodSeconds` in the Pod spec.

Updates: From Istio 1.12 `EXIT_ON_ZERO_ACTIVE_CONNECTIONS` flag was introduced to terminates proxy when number of active connections become zero during draining.

## Service Discovery

In the above section, we've talked about the connectivity issues between client / server Pod main container and their `istio-proxy` container. 

 What if the connnection issues happen between the source and destination Pod's `istio-proxy`?

<img src="{{site.url}}/assets/imgs/04-istio-proxy-xDS.svg"
     alt="Istio Proxy"
     style="display: block; width: 70%; margin: auto; background: white;" />

Inter-pod communication is always complicated, either with or without Istio. The issue may happen in any layer of the network - kube-proxy, network cni, node issues, sometimes even physical issues in cloud providers.

Since istio introduces extra ability to manage the connections for better traffic management, as the price, it has more possibilities of getting potential connectivity issues.

A lot of times, application teams come and complain about connectivity issues. Basically there was intermediate connection failures between client and server deployments.


A very common connectivity issues we've met since adapting Istio is `503 upstream_reset_before_response_started`, it's printed from `istio-proxy` log in the client Pod when the pod tries to access the service pod via kubernetes service address.  The problem is happening from time to time, it's not so critical but very annoying.


Sometimes the issues became more frequent, and teams would ask SRE to look at the root cause. The dialogs have a very similar pattern:
```
(Client Team): Our client applications shows 100+ 503s within last hour, there were spikes of timeout events from time to time.
(Server Team): We've checked our server application's logs, we have 99.999% successful rate of service calls, and for 100% of the requests, we always return results (either good or error) within 10 seconds.
(Client Team): We didn't touch any client code in last 2 weeks, so it's unlikely a client issue.
(Server Team): This backend is not changed over 3 months, so it's unlikely a server issues as well.
(SRE Team): We didn't touch any Istio settings recently, maybe the traffic was too much during the spike, let's increase the Pod number of the server pods.
... (SRE Team increases the server Pods number) ...
... Some time later ...
(Client Team): The 503s was a bit better when we scaled up, but after a while, 503 comes again.
(Server Team): We still confirmed 99.999% SLAs.
(SRE Team): ...
```

To figure out the issue, we need to closely look into the istio-proxy access logs.

The following is a failed service call log.
 
```
[2023-11-12T22:28:36.878Z] "POST /service HTTP/1.1" 503 UC 0 95 44456 - - "20f7f7e8-49f1-448c-a007-8806deec0414" "yourdomain.com" "10.10.10.10:80"
```

From the log we could figure out some detailed information around this call - when did it happen, http status, byte transferred, conneciton time, response time, request id, request domain, upstream hosts, etc.

The key field in the error log is the upstream host `10.10.10.10:80`, which is the exact IP / Port this request goes to. And this IP is actually the service Pod's IP address. We can use this IP address to back search the actual service Pod name, and we may be able to find out the Pod's logs to troubleshoot.

We tried to back search the original Pod's information of those 503 request logs, and we found those IPs are mostly from already terminated Pods.

<img src="{{site.url}}/assets/imgs/04-phantom-pod.svg"
     alt="Istio Proxy"
     style="display: block; width: 70%; margin: auto; background: white;" />

The connections made to the terminated Pods will never be successfully established, but instead of immediatly fail the connection, it will hung there until client Pod's istio-proxy exceed the connection timeout limit.

Why would this phantom connection happen? Why client Pod would connect to a Pod that is already terminated? Why can't the client Pod's `istio-proxy` to try testing the pod liveness before making the connection?

### xDS

Let's pick some memories about how load balancing was done with / without Istio in [L4 Vs L7](./03-L4-Vs-L7.md). We can reuse the example of nginx, how does a client's Pod's istio-proxy choose a Pod to connect to when the client's main container needs to create a TCP connection to `nginx-service.namespace.svc.cluster.local`?

The answer is - service Pods need to register / deregister themselves, and client pods need to update the service Pods' registeration information. 

The design philosophy of istio is that it keeps most of the information needed by runtime in `istio-proxy`, and the information is got from centralized control plane - istiod.

So you can understand like this: In `istio-proxy`'s memory, it contains a map that holds information like following. Basically we need to know which service have what Pods, and each Pod's status. (healthy, unhealthy, etc)

```
serviceA  ------ serviceA-pod-1 (healthy)
            |___ serviceA-pod-2 (unhealthy)
            |___ serviceA-pod-3 (healthy)
            ...

serviceB ------- serviceB-pod-1 (healthy)
            |___ serviceB-pod-2 (healthy)
            |___ serviceB-pod-3 (unhealthy)
            ...            
...
```

When a Pod is created and injected with `istio-proxy`, the `istio-proxy` container gets this full service map from `istiod`.

Of course, service Pods also changes on the fly. So when a service Pod is created / terminated / changed probe status, `istiod` will receive the information from either the service Pod's `istio-proxy`, or it proactively monitor the service events from kubernetes, it will update the service map entries, and then eventually it will push these updates to all the `istio-proxy` containers on the kubernetes.

The protocol of these service entry updates is called **xDS**. You might have seen tthishe word in Istio's documentation once or twice, it appears more often in envoy's documentation. (For relationship between Istio and Evnoy, please see the previous [article](./02-Istio-Vs-Envoy.md))


The word `xDS` contains two parts - `x` is one of the **C**luster / **L**istener / **E**ndpoint / **R**oute's initial and `DS` is short for Discovery Service. The process of `istiod` synchronizing these information to `istio-proxy` is called xDS push.

xDS push doesn't come for free, it takes time, especially if there are a lot of services in the kubernetes cluster, or a lot of Pods injected with `istio-proxy` container, or there are very frequent service updates happening.

Say a server Pod is terminated, it takes *T* time before all client Pods' `istio-proxy` updated their own service map to remove this Pod from the list. But during the *T* time, there is still possiblity the server Pod is picked by the client Pods for establishing TCP connection. Once it happend, it caused the issue we met above.

Once we've reconized this issue, we could think of multiple ways to mitigate it.

#### Reduce xDS push time

The very direct solution to mitigate the phantom connection is to reduce the *T* time. Istio exposes metrics for you to observe xDS push performance, and usually `pilot_proxy_convergence_time` is the key metric you should monitor.

There are many different ways to reduce the push time.

#### Increase istiod replicas
Since `istiod` plays the key role of collecting and pushing xDS messages from / to `istio-proxy`, more replicas would help to reduce the ops throughput of 1 istiod Pod, you should spend some time to adjust the istiod's kubernetes Pod spec and HorizontalPodAutoscaling and make sure there is sufficient resource allocated to it.

Following is the example of tuning istiod in IstioOperator.
```yaml
apiVersion: install.istio.io/v1alpha1
kind: IstioOperator
spec:
   components:
    pilot:
      k8s:
        resources:
          requests:
            cpu: 300m
            memory: 2Gi
        hpaSpec:
          minReplicas: 8
          maxReplicas: 64
          metrics:
          - type: Resource
            resource:
              name: cpu
              targetAverageUtilization: 100
```


#### Remove unnessary xDS push
 
We could increase istiod number to reduce the workload of each istiod, but the overal xDS push volume doesn't reduce. If we can reduce the xDS push volume, that would be a more effective way to improve xDS push delay.

In the above section we've described how client's istio-proxy would memorize the service map with the xDS push process. With `istioctl` you would be able to inspect the mapping on the fly.

```
~ istioctl proxy-config cluster client-pod-1.namespace
SERVICE FQDN                                          PORT     SUBSET                               DIRECTION     TYPE             DESTINATION RULE
                                                      80       -                                    inbound       ORIGINAL_DST
BlackHoleCluster                                      -        -                                    -             STATIC
InboundPassthroughClusterIpv4                         -        -                                    -             ORIGINAL_DST
InboundPassthroughClusterIpv6                         -        -                                    -             ORIGINAL_DST
PassthroughCluster                                    -        -                                    -             ORIGINAL_DST
agent                                                 -        -                                    -             STATIC
server.namespace.svc.cluster.local                    80       v1                                   outbound      EDS              
server.namespace.svc.cluster.local                    80       v2                                   outbound      EDS      
otherservice1.namespace.svc.cluster.local             80       -                                    outbound      EDS              
otherservice2.namespace.svc.cluster.local             80       -                                    outbound      EDS   
...
prometheus_stats                                      -        -                                    -             STATIC
```

The above commane `proxy-config cluster` shows the CDS configuration, you could see that it contains some common services like `BlackHoleCluster`, `InboundPassthroughClusterIpv(4|6)`, `PassthroughCluster`, etc., it also contains the kubernetes service clusters, such as `server.namespace.svc.cluster.local` and others.

If you inspect this in a real kubernetes cluster without proper tuning of Isito, you will find one of the biggest pitfall of Istio's default setting - It will make **every single Pod** to receive the xDS push for **every single kubernetes service**!

Ideally in above example, `client-pod-1` only need to receive xDS push for `server.namespace.svc.cluster.local`, but it ended up receiving xDS push for all other services in the kubernetes cluster, so it is with all the other Pods injected with `istio-proxy` in the kuberentes cluster. So the xDS push volume grows bigger and bigger with more Pods and service count.

What is the ideal situation is that every Pod only receives nessasary xDS push for the services that 1) it needs to connect to the service, 2) it needs to make use of the L7 proxy features.

But if you just follow Istio official examples, they won't tell you to tune this since xDS push won't be a bottleneck for simple senarios. But it is definitely worth tuning if you have more than dozens of services and more than thounsands of Pods on the same kubernetes clusters. 

The key Istio component to tune this is [Sidecar](https://istio.io/latest/docs/reference/config/networking/sidecar/), this "Sidecar" is not the "sidarcar" container which is `istio-proxy`, but rather to control "who cares what".

For the very first step, I would highly recommend you to add a default `Sidecar` for every namespace you would like to enable istio injection.

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Sidecar
metadata:
  name: default
spec:
  egress:
  - hosts:
    - '~/*'
  outboundTrafficPolicy:
    mode: ALLOW_ANY
```

What does this do? 

1. The `default` Sidecar without `workloadSelector` will be the fallback rule for all `istio-proxy` containers in this namespace Pods.
2. The `egress.hosts[0]` with value `~/*` means by default `istio-proxy` container will not receive any service xDS push from any namespace
3. The `outboundTrafficPolicy.mode` with value `ALLOW_ANY` means `istio-proxy` will delegate the traffic control back to `kube-proxy`

Simply by setting this up, we will reduce 99% of the xDS pushes, but it also means we loses the the L7 layer traffic management features provided by Istio, and the behavior rolled back to kubernetes default.

We definitely still want the L7 layer traffic management between the client and server, so we could add additional Sidecar configuration to cover this case.

```yaml
apiVersion: networking.istio.io/v1beta1
kind: Sidecar
metadata:
  name: client-sdc
spec:
  egress:
  - hosts:
    - namespace/server.namespace.svc.cluster.local
  workloadSelector:
    labels:
      app: client
```

The above configuration allows the `client` Pods to be registered with xDS push for `server.namespace.svc.cluster.local` service changes, and the traffic management is taken over by Istio.

With the two types of Sidecar above, we've changed the "all in xDS" behavior to "selective xDS", and from my testing on a real prodution kubernetes cluster, it reduces 80% of the xDS push and dramatically improved the istiod resource consumption and the xDS push time.

#### Outlier detection

We can do a lot of efforts to reduce the xDS push time, however you could never reduce it to 0. After the optimization we've done in previous sections, we've reduced the push time to < 100ms in p99. This is already great improvement, but 100ms is still relatively long compared to the QPS that our cliend Pod requesting server Pod, so whenever a server Pod is terminated, there are still 503 errors from client to server.

When we take a look at the logs and try to find out all the failed requests during a period, we found very interesting patterns - The failed requests were distributed among different client Pods, and each Pod failed for no more than 5 times. It seems that the client Pod will passively retry for other hosts if it experience a certain number of connection failures to a specific server Pod.

This is yet another advanced traffic management feature that provided by Istio, which is not covered in [L4 Vs L7](./03-L4-Vs-L7.md), called **Outlier Detection**.

xDS push will make the server Pods status to be eventually synced to the client Pods, and outlier detection is an addition support - before xDS push arrive, if the client Pod already experienced X times connection error to the destination Pod, it will mark it an "outlier" locally and avoid using it for a while.

Outlier detection is by default enabled, and default values can be found in the [official documentation](https://istio.io/latest/docs/reference/config/networking/destination-rule/#OutlierDetection).

One "pitfall" of the default outlier detection is that, it will only mark a upstream Pod to be outliered after 5 consecutive 5xx errors, that's matching what we've observed from the client logs. The problem is that under this case, we'd want the client Pod to immediately choose another Pod for the next fortune, instead of meeting 5 failures in a row.

So we've made following adjustment to let this outlier detection to be more effective. 


```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
spec:
  host: server.namespace.svc.cluster.local
  trafficPolicy:
    outlierDetection:
      baseEjectionTime: 10s
      consecutive5xxErrors: 1
```
`consecutive5xxErrors` is configured to be 1, which is most aggressive to make the client Pod choose another Pod for service connection after 1 503 timeout events.

`baseEjectionTime` is the time that outlier status will initially last before client Pod retries the Pod again, it is configured to be 10 seconds, and most likely within  this time, xDS push will arrive and remove this Pod from xDS entries entirely.

With the above setting, we've seen a client Pod will at most experiencing 503 once for a server Pod, and the timeout events reduced to 20% ~ 30% percent compared to before.

The outlier detection has some very detailed and interesting settings, and I suggest you taking a look at the documenetation and fine tune it for your own use case.

#### Retry, retry and retry

After tuning wthe outlier detection, we are actually pretty satisfied with the sucessful rate, but the 503s still exists, if we have 100 client pods, it might cause 100 timeouts when a server Pod is terminated.

Could we aim for zero 503s?

The answer is Yes.

`VirtualService` supports configuration of retries for HTTP routes. It allows you to configure how many times you want to retry, and under what conditions you want to retry, etc.

Originally we've configured retries as following, to let it retry at most 3 times when encounting gateway error, connection failures, etc.


```yaml
# Source: houzz.c2-thrift.flip/templates/vs.yaml
kind: VirtualService
metadata:
  name: nginx-service-vs
spec:
  host: nginx-service.namespace.svc.cluster.local
  http:
  - name: main
    route:
    - destination:
        host: nginx-service.namespace.svc.cluster.local
    retries:
      attempts: 3
      retryOn: 'gateway-error,connect-failure,refused-stream,reset,503'
```

But from the results, it doesn't work out well for the 503s to terminated Pods, and by carefully checking the documentation, we found this pitfall.

```yaml
spec:
   http:
     retries:
       attempts: 3
       retryOn: 'gateway-error,connect-failure,refused-stream,reset,503'
       retryRemoteLocalities: true
```

`http.retries.retryRemoteLocalities` is a flag to configure whether the retry should be to another Pod, or the same Pod, and default value is `false`. The perfectly explains why it doesn't work - the destination Pod is already terminated, it won't succeed no matter how many times you retries the same Pod. Switch this value to `true` makes the retry to retry another Pod, and in most cases it would work, even if it's very unlucky to connect to another terminated Pod, it have 3 attempts so it most likely to get through eventually.

With this final tuning, we've successfully made 503 timeout issues from several hundreds per day to nearly 0! This is definitely better than prior to use Istio.

## Conclusion

In this blog post, we could see how we identify and tune the Istio step by step, and finally achieved "better" connection than without using Istio.

Waiting for dependency, graceful shutdown, outlier detection, retries, these are not new concepts created by Istio, developers used to implement these logics themselves in their application code. Istio make the logic embed in the service mesh layer and make it completely transparent to application.

Also, it is noticable that the advanced traffic management features (outlier, retry) only supports L7 layer protocols (HTTP, gRPC, etc), if you want your system to benefit from it, you would choose your application protocols wisely.