# ADR 0003: Object storage for media exchange

Status: Accepted

Large media is uploaded directly to S3-compatible object storage. Services exchange object keys and metadata. This avoids memory pressure, gateway timeouts, duplicated bandwidth, and tightly coupled service APIs.
