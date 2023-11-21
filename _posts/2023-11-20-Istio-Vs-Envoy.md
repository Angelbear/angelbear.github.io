---
layout: single
categories: istio
date:  2023-11-20 17:00:00 +0800
author: Yangyang Zhao
---

If you looked at the documentation of Istio, this terminology `envoy` appears multiple ones. Also, there are some concepts like `EnvoyFilter`  that you might come up in the Istio documentation.

Assuming you've already had experience of instealling Istio, you may find there are two essential kubernetes components - `istiod` deployment and `istio-proxy` sidecar container. And in `istio-proxy` container you can find  there is this `envoy` process forked from `pilot-agent`

```
USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
istio-p+     1  0.0  0.1 745700 36476 ?        Ssl  Oct19   2:29 /usr/local/bin/pilot-agent proxy sidecar --domain <app>.svc.cluster.local --serviceCluster <svc>.<ns> --proxyLogLevel=warning --proxyComponentLogLevel=misc:error --log_out
istio-p+    33  8.0  0.2 496548 95728 ?        Sl   Oct19 376:12 /usr/local/bin/envoy -c etc/istio/proxy/envoy-rev0.json --restart-epoch 0 --drain-time-s 45 --drain-strategy immediate --parent-shutdown-time-s 60 --service-cluster <svc>
istio-p+    78  0.0  0.0  18660  3328 pts/0    Ss   04:57   0:00 bash
istio-p+    95  0.0  0.0  34424  2712 pts/0    R+   04:58   0:00 ps aux
```
The relationship between `Istio` and `Envoy`, is like the relationship between `Kubernetes` and `Docker`. [Envoy](https://www.envoyproxy.io/) is a standalone proxy tool designed for cloud native applications. If you take a look at `istio-proxy`'s source code - https://github.com/istio/proxy, it is depending on https://github.com/envoyproxy/envoy.

Configuring `Istio` and `Envoy` is completely differnt, a typical Istio resource looks like

~~~ yaml
apiVersion: networking.istio.io/v1alpha3
kind: VirtualService
metadata:
  name: reviews-route
spec:
  hosts:
  - reviews.prod.svc.cluster.local
  http:
  - name: "reviews-v2-routes"
    match:
    - uri:
        prefix: "/wpcatalog"
    - uri:
        prefix: "/consumercatalog"
    rewrite:
      uri: "/newcatalog"
    route:
    - destination:
        host: reviews.prod.svc.cluster.local
        subset: v2
  - name: "reviews-v1-route"
    route:
    - destination:
        host: reviews.prod.svc.cluster.local
        subset: v1
~~~

While `envoy` configration looks like

~~~ yaml
static_resources:

  listeners:
  - name: listener_0
    address:
      socket_address:
        address: 0.0.0.0
        port_value: 10000
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: ingress_http
          access_log:
          - name: envoy.access_loggers.stdout
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.access_loggers.stream.v3.StdoutAccessLog
          http_filters:
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
          route_config:
            name: local_route
            virtual_hosts:
            - name: local_service
              domains: ["*"]
              routes:
              - match:
                  prefix: "/"
                route:
                  host_rewrite_literal: www.envoyproxy.io
                  cluster: service_envoyproxy_io

  clusters:
  - name: service_envoyproxy_io
~~~

For most of the Istio usages, you do not need to touch envoy related settings. Because 
[pilot_agent](https://github.com/istio/istio/tree/master/pilot/cmd/pilot-agent) does the job to **translate your Istio configuration and other dynamic information into the envoy configurations**, and it bootstraps the `envoy` process, while `envoy` actually does the job to handle all incoming / outgoing network traffic of the pod.

Sometimes you still need to touch the `envoy` related configurations, if you use [Envoy Filters](https://istio.io/latest/docs/reference/config/networking/envoy-filter/).

~~~ yaml
apiVersion: networking.istio.io/v1alpha3
kind: EnvoyFilter
metadata:
  name: custom-protocol
  namespace: istio-config # as defined in meshConfig resource.
spec:
  configPatches:
  - applyTo: NETWORK_FILTER
    match:
      context: SIDECAR_OUTBOUND # will match outbound listeners in all sidecars
      listener:
        portNumber: 9307
        filterChain:
          filter:
            name: "envoy.filters.network.tcp_proxy"
    patch:
      operation: INSERT_BEFORE
      value:
        # This is the full filter config including the name and typed_config section.
        name: "envoy.extensions.filters.network.mongo_proxy"
        typed_config:
          "@type": "type.googleapis.com/envoy.extensions.filters.network.mongo_proxy.v3.MongoProxy"
          ...
  - applyTo: NETWORK_FILTER # http connection manager is a filter in Envoy
    match:
      # context omitted so that this applies to both sidecars and gateways
      listener:
        filterChain:
          filter:
            name: "envoy.filters.network.http_connection_manager"
    patch:
      operation: MERGE
      value:
        name: "envoy.filters.network.http_connection_manager"
        typed_config:
          "@type": "type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager"
          common_http_protocol_options:
            idle_timeout: 30s
~~~

Either modifying "pure" Istio or envoy configurations, `pilot-agent` will translate the new configuraion into the envoy configuraion file, and cause `envoy` to hot reload the new configurations.


To get experience of modifying the spec part, we need to reference envoy's own [documentation site](https://www.envoyproxy.io/docs/envoy/latest/).

From my personsal experience, envoy configuration is completely unfriendly to freshers of `Istio`. The biggest problem of it is that it contains too many terminalogies, covers a lot of topics, but lacks of examples. 

Usually I would go to [envoyproxy github issues](https://github.com/envoyproxy/envoy/issues) and search for keywords. I could always get inspirations from the detailed configurations under the issue descriptions and replies.