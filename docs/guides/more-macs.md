# More Macs, and the broker in a container

One Mac running `devicepool up` is the broker and the host at once. When a team adds Macs, or wants
Devicepool on its Kubernetes cluster, the broker moves out and every Mac joins it.

## Add a Mac to a running Devicepool

On the machine with the broker (the first Mac, or inside the container):

```bash
devicepool join-token
```

On the new Mac, with Xcode and idb installed:

```bash
devicepool join https://devicepool.example.com --token dp_host_...
```

The Mac dials out over one WebSocket to `/v1/agent/connect`, so it needs no open port and works
from behind NAT. Its simulators show on the Devices page next to the others, and leases are
placed on any Mac with a matching device. If the connection drops, the Mac keeps its devices
and leases and reconnects, waiting up to 30 s between tries; its leases survive if it is back
within a minute. `--warm` and `--max` work as they do for `devicepool up`.

To start a Mac's Devicepool at login or at boot without anyone at it, see
[unattended.md](unattended.md).

A host token does not expire. Anyone with it can offer devices to your Devicepool, so keep it like
a password.

## Run the broker alone

```bash
devicepool broker --url https://devicepool.example.com
```

This is the broker without devices of its own. It prints a sign-in link for the admin and a
`devicepool join` line for the Macs. In a container:

```bash
docker build -t devicepool .
docker run -d --name devicepool -p 7420:7420 -v devicepool:/data -e DEVICEPOOL_URL=https://devicepool.example.com devicepool
docker logs devicepool
docker exec devicepool devicepool join-token
```

The image keeps everything (SQLite, builds, recordings) in `/data`. On Kubernetes, the chart in
`deploy/helm/devicepool` runs one replica with a volume, and an optional ingress whose annotations
keep WebSockets open:

```bash
helm install devicepool deploy/helm/devicepool --set url=https://devicepool.example.com \
  --set ingress.enabled=true --set ingress.host=devicepool.example.com
```

Run only one broker per database. Two would hand the same device to two people.

## Keep builds and recordings in a bucket

By default the broker keeps builds and recordings in its data folder. To keep them in an
S3-compatible bucket instead (AWS S3, MinIO, Cloudflare R2, Ceph), set:

```bash
DEVICEPOOL_S3_ENDPOINT=https://s3.eu-north-1.amazonaws.com
DEVICEPOOL_S3_BUCKET=devicepool
DEVICEPOOL_S3_REGION=eu-north-1
DEVICEPOOL_S3_ACCESS_KEY=...
DEVICEPOOL_S3_SECRET_KEY=...
```

Files are written to the data folder while they arrive, then uploaded and removed, so the broker
needs disk only for what is in flight. Downloads still go through the broker, which checks who
asks; Macs and browsers never get bucket credentials. Devicepool uses path-style addresses
(`<endpoint>/<bucket>/<key>`), which MinIO and most S3-compatible stores expect.

## Move from the first Mac to the container

```bash
# On the Mac, with Devicepool running or stopped:
devicepool export devicepool.tar

# Where the broker will run, with an empty data folder:
devicepool import devicepool.tar
```

The file holds a copy of the database (accounts, tokens, lease and run history, builds and
recordings), so people keep their sign-ins and CI keeps its tokens. With a bucket set, builds and
recordings already in it stay there and are not in the file; point the new broker at the same
bucket. Keep it as safe as the Mac.
For a container, run the import against the volume before the first start:

```bash
docker run --rm -v devicepool:/data -v "$PWD":/in devicepool devicepool import /in/devicepool.tar
```

Then stop `devicepool up` on the Mac and run `devicepool join` there instead.
