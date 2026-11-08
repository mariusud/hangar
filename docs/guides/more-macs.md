# More Macs, and the broker in a container

One Mac running `hangar up` is the broker and the host at once. When a team adds Macs, or wants
Hangar on its Kubernetes cluster, the broker moves out and every Mac joins it.

## Add a Mac to a running Hangar

On the machine with the broker (the first Mac, or inside the container):

```bash
hangar join-token
```

On the new Mac, with Xcode and idb installed:

```bash
hangar join https://hangar.example.com --token hgr_host_...
```

The Mac dials out over one WebSocket to `/v1/agent/connect`, so it needs no open port and works
from behind NAT. Its simulators show on the Devices page next to the others, and leases are
placed on any Mac with a matching device. If the connection drops, the Mac keeps its devices
and leases and reconnects, waiting up to 30 s between tries; its leases survive if it is back
within a minute. `--warm` and `--max` work as they do for `hangar up`.

A host token does not expire. Anyone with it can offer devices to your Hangar, so keep it like
a password.

## Run the broker alone

```bash
hangar broker --url https://hangar.example.com
```

This is the broker without devices of its own. It prints a sign-in link for the admin and a
`hangar join` line for the Macs. In a container:

```bash
docker build -t hangar .
docker run -d --name hangar -p 7420:7420 -v hangar:/data -e HANGAR_URL=https://hangar.example.com hangar
docker logs hangar
docker exec hangar hangar join-token
```

The image keeps everything (SQLite, builds, recordings) in `/data`. On Kubernetes, the chart in
`deploy/helm/hangar` runs one replica with a volume, and an optional ingress whose annotations
keep WebSockets open:

```bash
helm install hangar deploy/helm/hangar --set url=https://hangar.example.com \
  --set ingress.enabled=true --set ingress.host=hangar.example.com
```

Run only one broker per database. Two would hand the same device to two people.

## Keep builds and recordings in a bucket

By default the broker keeps builds and recordings in its data folder. To keep them in an
S3-compatible bucket instead (AWS S3, MinIO, Cloudflare R2, Ceph), set:

```bash
HANGAR_S3_ENDPOINT=https://s3.eu-north-1.amazonaws.com
HANGAR_S3_BUCKET=hangar
HANGAR_S3_REGION=eu-north-1
HANGAR_S3_ACCESS_KEY=...
HANGAR_S3_SECRET_KEY=...
```

Files are written to the data folder while they arrive, then uploaded and removed, so the broker
needs disk only for what is in flight. Downloads still go through the broker, which checks who
asks; Macs and browsers never get bucket credentials. Hangar uses path-style addresses
(`<endpoint>/<bucket>/<key>`), which MinIO and most S3-compatible stores expect.

## Move from the first Mac to the container

```bash
# On the Mac, with Hangar running or stopped:
hangar export hangar.tar

# Where the broker will run, with an empty data folder:
hangar import hangar.tar
```

The file holds a copy of the database (accounts, tokens, lease and run history, builds and
recordings), so people keep their sign-ins and CI keeps its tokens. With a bucket set, builds and
recordings already in it stay there and are not in the file; point the new broker at the same
bucket. Keep it as safe as the Mac.
For a container, run the import against the volume before the first start:

```bash
docker run --rm -v hangar:/data -v "$PWD":/in hangar hangar import /in/hangar.tar
```

Then stop `hangar up` on the Mac and run `hangar join` there instead.
