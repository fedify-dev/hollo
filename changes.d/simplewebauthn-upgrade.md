---
priority: -10
---
 -  Upgraded *@simplewebauthn/server* to 14.0.3 and
    *@simplewebauthn/browser* to 14.0.0, refreshing the vendored browser
    bundle to match.  The server release fixes two moderate-severity
    vulnerabilities in attestation certificate revocation handling, and version
    14 adds post-quantum ML-DSA passkey support on runtimes that provide the
    algorithms.  [[GHSA-2g3p-m8c9-hhwh], [GHSA-j3h4-m3m2-7p7j]]

[GHSA-2g3p-m8c9-hhwh]: https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-2g3p-m8c9-hhwh
[GHSA-j3h4-m3m2-7p7j]: https://github.com/MasterKale/SimpleWebAuthn/security/advisories/GHSA-j3h4-m3m2-7p7j
