// ENG-1799 demo: refuse every connection to a host name other than localhost, for Node tools the demo runs that
// would otherwise call the internet (the Lightdash CLI posts usage analytics to analytics.lightdash.com and checks
// GitHub for upgrades on every run). The demo makes no network calls (docs/eng-1799/demo.md); its own services all
// listen on 127.0.0.1 IP literals, which never go through DNS.
//
//   NODE_OPTIONS="--import <this file>" <command>
//
// Node resolves every host name it connects to (http, https, node-fetch, undici's fetch) with dns.lookup; this
// answers ENOTFOUND for anything but localhost, so the tool sees an offline machine and carries on.
import dns from 'node:dns';

const realLookup = dns.lookup;
const LOCAL = new Set(['localhost', '127.0.0.1', '::1']);

dns.lookup = function lookup(hostname, options, callback) {
    if (LOCAL.has(String(hostname).toLowerCase())) return realLookup.call(this, hostname, options, callback);
    const cb = typeof options === 'function' ? options : callback;
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname} (the ENG-1799 demo makes no network calls)`), {
        code: 'ENOTFOUND',
        errno: -3008,
        syscall: 'getaddrinfo',
        hostname,
    });
    process.nextTick(cb, err);
    return undefined;
};
