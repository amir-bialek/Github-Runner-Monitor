# Deploying with Helm

One generic chart, installed twice — once for the backend, once for the frontend, as two separate releases in the same namespace. `chart/` is a general-purpose chart used as-is; `values-backend.yaml` and `values-frontend.yaml` are what make it this app.

## Before you install

Build and push the two images (or point at wherever you host them), then create the secret holding the GitHub token — it never goes in a values file:

```bash
kubectl create secret generic github-runner-monitor-token \
  --from-literal=token=<your-fine-grained-token>
```

See the main [README](../README.md#using-real-github-data) for what the token needs.

## Install

```bash
helm install runner-monitor-backend ./chart \
  -f values-backend.yaml \
  --set deployment.image.name=<your-registry>/github-runner-monitor-backend \
  --set deployment.env.regular.GITHUB_ORGANIZATION=<your-org>

helm install runner-monitor-frontend ./chart \
  -f values-frontend.yaml \
  --set deployment.image.name=<your-registry>/github-runner-monitor-frontend
```

The frontend's nginx forwards `/api` to a Service named exactly `backend` — that name is baked into the frontend image at build time, not templated. Don't rename the backend Service unless you also change `docker/nginx.conf` and rebuild the frontend image.

By default neither release makes itself reachable from outside the cluster. Turn on `ingress.enabled` in `values-frontend.yaml` and fill in a real host, or `kubectl port-forward svc/frontend 8080:80` to look at it locally.

## Check the output before installing

```bash
helm template runner-monitor-backend ./chart -f values-backend.yaml
```

No token or secret value should appear anywhere in the output — only a reference to the secret's name.

## Uninstall

```bash
helm uninstall runner-monitor-backend runner-monitor-frontend
```
