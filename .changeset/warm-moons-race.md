---
'@sledorze/falsestart': minor
---

New rule `no-raw-fetch`.

`fetch` hides four things the caller has to get right and its type says none of them. A rejected
promise carries `unknown`, so a DNS failure, an aborted connection and a malformed URL are
indistinguishable at the catch site. **A non-2xx response does not reject at all** — it resolves, so
code that forgot `res.ok` proceeds with an error page as though it were data. There is no
interruption unless an `AbortController` is threaded through by hand. And there is no timeout or
retry policy, so both get reimplemented per call site, differently each time.

`HttpClient` gives all four as declared, composable things: the error channel is typed
(`HttpClientError`), the request is interruptible because it is an Effect, and `Effect.timeout` and
`Effect.retry` apply to it like anything else. `FetchHttpClient` is the layer that runs it on the
platform's own `fetch`, so this is a change of interface rather than of transport. Where a full
client is more than the call needs, `Effect.tryPromise` is the minimum honest wrap.

Only the bare global is matched — `repository.fetch(id)` is somebody else's method.

**This can flip a previously-passing repo to failing**, and it will fire on ordinary code. Note the
rule's stated caveat: `HttpClient` lives in `effect/unstable/http`, which the root `effect` import
does not re-export and whose path says the surface may still move. `Effect.tryPromise` is in core
and closes the error-channel half on its own.

Also: `src/remedies.test.ts` now verifies `HttpClient.*` and `HttpClientRequest.*` names, which it
previously could not — its regex only looked at eight root namespaces, so any message naming a
subpath API was unchecked. Confirmed by breaking it: `HttpClient.fetchNope` fails the suite by name.
