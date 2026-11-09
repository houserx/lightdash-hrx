/**
 * A request recorder (Harness API `startRecorder()`): a `FakeServer` that answers 200 `{}` to
 * every request. It stands in for HTTP receivers the app calls out to, such as incident.io,
 * webhooks and the alerting heartbeat URL; checks read `requests`.
 */
import { jsonReply, startFakeServer, type FakeServer } from './fakeServer';

export function startRecorder(): Promise<FakeServer> {
    return startFakeServer(() => jsonReply({}));
}
