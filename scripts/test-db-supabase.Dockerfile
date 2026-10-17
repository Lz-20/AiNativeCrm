# Offline fallback using the PostgreSQL 15 / pgvector binaries already cached.
# NOT a production image: fresh vanilla cluster, no vendor initialization,
# background workers, event triggers or server configuration. The harness
# supplies the Supabase ACL prelude and replaces postgres for every test file.
# Local socket is trusted; TCP requires the disposable harness password.
# Do not reuse this image for CRM deployment or durability certification.
# Normal CI/default remains pgvector/pgvector:pg15.
FROM public.ecr.aws/supabase/postgres:15.8.1.085
CMD ["gosu", "postgres", "bash", "-ceu", "initdb -D /tmp/pi-native-test-pg -U postgres --auth-local=trust --auth-host=scram-sha-256 --pwfile=<(printf '%s\\n' \"${POSTGRES_PASSWORD:?}\") >/dev/null; printf '%s\\n' 'host all all 0.0.0.0/0 scram-sha-256' 'host all all ::/0 scram-sha-256' >> /tmp/pi-native-test-pg/pg_hba.conf; exec postgres -D /tmp/pi-native-test-pg -c listen_addresses='*' -c port=5432"]
