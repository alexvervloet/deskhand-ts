# Migrations

Applied in filename order by `npm run migrate`, once each, recorded in
`schema_migrations`. Files are immutable once applied — to change the schema,
add a new one.

These are byte-identical to the Python service's migrations, which is
deliberate: a refund this runtime issues should be indistinguishable from one
the Python worker issues, and sharing a schema is how that claim stays
checkable.

`0007_waitpoint_token.sql` is missing on purpose. It added a Trigger.dev
waitpoint token id to `approvals`, and a run here is resumed by a worker
polling the queue rather than by a token being completed. The gap in the
numbering is kept so the two directories still diff file by file.
