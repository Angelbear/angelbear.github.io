---
layout: single
categories: istio
date:  2023-11-20 16:00:00 +0800
author: Yangyang Zhao
---

I started to get in touch with Istio from 2020, when the Istio version was still around 1.6-ish. I was not the person who introduced Istio to the company, there was another engineer who was also a newbie to Istio, spending some time studying it, then installed and created the initial setup of istio eco system, and the company started to use it.

Unfortunately, not long after it was introduced, the guy who introduced Istio to the company resigned. He was the person who had the best knowledge of Istio by then (yet can not say he was a master of Istio). He tried his best to do the knowledge transfer before his last day, and I tried my best to digest them.

Obviously I wasn't able to absort that much, and I started my 3 years fighting with it. Unlike many other open source networking tools, like Haproxy for instance, the concept & usage of istio is not straightforward. The debugging of istio related issues is hard - sometimes you can't just reproduce the issues 100%, but it happens, even with 0.x% of the possibility, but not acceptable if you want to achieve 99.9% or 99.99% availaibility.

During 2020 ~ 2023, I met couple of issues that are related to istio, and I was able to spot and solve most the problems, but very ineffective. I spent days and days on verifying my hyposis, adjusting different settings, dug into the source code. Often the tryouts didn't work, or even caused more problems. After solving the problems, the solutions seem to be very straightforward and I should have done it ever since adapting Istio. 

Every time I experience the "aha moment", I would doubt that "Am I smart enought to use Istio? Was it a wrong decision to adapt Istio in the company given the learning curve is so steep?". 

The fact is that to understand the Istio concepts, and master its usages, requires the person to have a good understanding of networking already. To most of the software engineers, it is hard, because networking was so well encapsulated so engineers barely need to write networking code in their daily life.


This book is a series of articles that describe the understanding of istio related concepts, from a non vereran's perspective.

You don't have to read this book if:

* You do not use Istio
* You are a veteran of Istio
* You want to learn Istio in the "right" way
