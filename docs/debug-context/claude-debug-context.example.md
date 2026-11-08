# Debug context for acme/payments-api

## About this repo

payments-api is the Node.js service that takes card payments for the acme web shop.
CI runs on the self-hosted `linux-large` pool: `npm ci`, then lint, unit tests and an
integration suite that starts Postgres 16 in a service container.

## Common failures

- **Integration tests time out**: the Postgres service container is still starting.
  The `wait-for-db` step must run before `npm run test:integration`.
- **`npm ci` fails with EINTEGRITY**: `package-lock.json` was edited by hand.
  Regenerate it with `npm install` and commit the result.
- **Docker build fails on `COPY shared/`**: the shared configuration now comes from
  the `acme/shared-config` package; update the Dockerfile, not the workflow.

## Extra repositories

- shared-actions  the composite actions our workflows call
- acme/shared-config  the configuration package the Docker build installs
