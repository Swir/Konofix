# Security Policy

## Supported versions

Konofix is currently in the `0.4.x` test/pre-release phase. Security fixes target the latest commit on `main` and the current test build used for public-network validation. Older test builds may be superseded rather than patched individually.

## Reporting a vulnerability

Please use GitHub private vulnerability reporting / the repository Security Advisory flow when it is available. Do not publish exploit details, private keys, sensitive network-test artifacts, infrastructure credentials, or personal data in a public issue.

If private vulnerability reporting is not available in the repository UI, open a minimal public issue asking for a private security contact channel without including technical exploit details.

A useful report includes the affected commit or version, operating system, reproduction conditions, expected impact, and a minimal proof of concept when it can be shared safely.

## Handling reports

Reports are triaged against the current `main` branch. Security fixes should include regression coverage when practical and should pass the same Windows/Linux CI and artifact-integrity gates as ordinary changes.

A security fix does not by itself count as Real Internet Test evidence. Public-node promotion and release gates remain independent and still require the documented cross-network evidence.
