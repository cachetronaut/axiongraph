# Changelog

## Unreleased

## 0.0.7

- `reduce_all` (Python) and `reduceAll` (TypeScript) fold an event log in linear time: every event is applied to one private copy of the node and edge maps instead of copying them per event. Results, ordering and anomalies are unchanged; `reduce` stays pure. A 100,000-event snapshot now folds in about 0.03 s (it grew quadratically before).
- The PyPI release workflow checks out the sibling Dockbay sources its type check and tests resolve, as CI already does.

- Consolidated TypeScript and Python implementations into one primitive repository.
