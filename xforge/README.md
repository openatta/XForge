# @xforge/cli

Protocol-1 implementation of `xforge state`, `install`, `check`, and `archive`.
JSON is the default output. The CLI is offline once declared dependencies and
project assets are present. Active Changes may add an eight-field
`work-packages.yaml`; `state` resolves its DAG and delivery records, while
`check` verifies Git write boundaries and re-runs package verification into
bounded Evidence without becoming an Agent runtime.
