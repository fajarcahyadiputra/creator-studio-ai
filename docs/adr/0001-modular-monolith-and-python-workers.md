# ADR 0001: Modular monolith with separate Python workers

Status: Accepted

Node.js remains a modular monolith during early product development. Media and AI processing live in Python workers because their dependencies, resource profiles, release cadence, and GPU scaling differ. This gives simple product transactions without mixing operationally incompatible workloads.
