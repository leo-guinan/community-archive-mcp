# Privacy policy

This is the source of the policy the hosted connector serves at `/privacy`. The operator name and contact address come from the deployment's `OPERATOR` and `CONTACT` settings.

## What this service does

It lets an AI assistant (such as Claude) query the Community Archive API with your own API key. It reads public archive data on your behalf and returns it to the assistant. It doesn't write anything to the Community Archive.

## What we store

- **Your Community Archive API key**, encrypted, inside the authorization grant for each connection you approve. It can be decrypted only with that connection's own tokens, which we store only as hashes. We never display, log, or share it.
- **A fingerprint of your key** (a one-way hash) to group your connections and replace an old one when you reconnect.
- **Connection records** for the apps you authorize: the app's registered name and redirect address, granted scope, and expiry times.

If you send your key directly in a request header instead of signing in, it's used for that request and not stored.

## What we don't store

Your prompts, your assistant's conversations, or the archive results it receives, beyond a short-lived in-memory cache of public archive responses (minutes) that saves requests against your limits.

## Who receives data

Your key and your queries go only to the Community Archive API (analytics.community-archive.org) to answer the assistant's requests. The service runs on Cloudflare Workers; Cloudflare processes requests as our infrastructure provider. We don't sell or share data with anyone else.

## Retention

A connection's records and encrypted key are deleted when it expires (after 30 days without use, and at most one year), when you reconnect the same key to the same app, or when you ask us. Deleting your key on community-archive.org stops it working here immediately.

## Contact

Use the address on the deployment's `/privacy` page for questions or deletion requests.
