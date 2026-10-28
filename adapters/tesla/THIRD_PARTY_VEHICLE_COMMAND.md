# Third-party: teslamotors/vehicle-command

This adapter's experimental `signed-command.ts` implements the vehicle session
handshake and HMAC-SHA256 command authorization described in:

- Repository: https://github.com/teslamotors/vehicle-command
- Spec: `pkg/protocol/protocol.md`
- Reference implementation: `internal/authentication` (Signer / Verifier / NativeSession)
- License: Apache License 2.0

Copyright for that project belongs to its authors (Tesla, Inc. and contributors).
This bridge reimplements the documented protocol in TypeScript; it does not
vend the Go sources. Test vectors in our unit tests (shared ECDH key `K`,
session-info HMAC tag, AES-GCM worked example, HVAC Auto protobuf
`120452020801`) are taken from that protocol document.

DashcamSaveClipAction field number 47 is **not** part of the public
`car_server.proto` in that repository; it is community / reverse-engineered
knowledge and remains UNVERIFIED here until a live vehicle test.
