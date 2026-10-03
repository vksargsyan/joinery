#!/usr/bin/env bash
# Starts the NoSQL servers the integration and end-to-end tests use: a MongoDB replica set with
# auth, and a Redis (or Valkey) standalone with an ACL user, a replica watched by Sentinel, and a
# three-node Cluster. Service containers cannot take server arguments, so these run as plain
# containers on the host network.
#
# Usage: start-nosql.sh <mongo image tag> <redis image>, e.g. start-nosql.sh 8.0 redis:7.4
set -euo pipefail
mongo_tag=${1:?MongoDB image tag}
redis_image=${2:?Redis or Valkey image}
case "$redis_image" in
  valkey/*) server=valkey-server cli=valkey-cli ;;
  *) server=redis-server cli=redis-cli ;;
esac

wait_for() {
  for _ in $(seq 1 90); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for: $*" >&2
  return 1
}

# MongoDB: a one-member replica set (transactions and change streams need one) with auth.
keydir=$(mktemp -d)
openssl rand -base64 756 >"$keydir/keyfile"
chmod 400 "$keydir/keyfile"
sudo chown 999:999 "$keydir/keyfile"
docker run -d --name mongo --network host -v "$keydir/keyfile:/etc/mongo-keyfile:ro" \
  "mongo:$mongo_tag" --replSet rs0 --port 27018 --bind_ip 127.0.0.1 --keyFile /etc/mongo-keyfile
mongosh() { docker exec mongo mongosh --quiet --port 27018 "$@"; }
wait_for mongosh --eval 'db.runCommand({ ping: 1 }).ok'
mongosh --eval "rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27018' }] })"
wait_for sh -c "docker exec mongo mongosh --quiet --port 27018 --eval 'db.hello().isWritablePrimary' | grep -q true"
mongosh admin --eval "db.createUser({ user: 'querybara', pwd: 'querybara', roles: ['root'] })"

# Redis: standalone with a password and a restricted ACL user, plus a replica for Sentinel.
docker run -d --name redis --network host "$redis_image" "$server" --port 63790 \
  --bind 127.0.0.1 --requirepass querybara --masterauth querybara \
  --user app on '>app-secret' '~app:*' '&*' '+@all' '-@dangerous'
docker run -d --name redis-replica --network host "$redis_image" "$server" --port 63792 \
  --bind 127.0.0.1 --requirepass querybara --masterauth querybara --replicaof 127.0.0.1 63790
wait_for docker exec redis "$cli" -p 63790 -a querybara --no-auth-warning ping
docker run -d --name redis-sentinel --network host --entrypoint sh "$redis_image" -c \
  "printf 'port 26380\nbind 127.0.0.1\nsentinel monitor querybara-master 127.0.0.1 63790 1\nsentinel auth-pass querybara-master querybara\n' >/tmp/sentinel.conf && exec $server /tmp/sentinel.conf --sentinel"
for port in 7100 7101 7102; do
  docker run -d --name "redis-c$port" --network host "$redis_image" "$server" --port "$port" \
    --bind 127.0.0.1 --cluster-enabled yes --cluster-config-file "nodes-$port.conf" \
    --requirepass querybara --masterauth querybara
done
for port in 7100 7101 7102; do
  wait_for docker exec "redis-c$port" "$cli" -p "$port" -a querybara --no-auth-warning ping
done
docker exec redis-c7100 "$cli" -a querybara --no-auth-warning --cluster create \
  127.0.0.1:7100 127.0.0.1:7101 127.0.0.1:7102 --cluster-replicas 0 --cluster-yes
wait_for sh -c "docker exec redis-c7100 $cli -p 7100 -a querybara --no-auth-warning cluster info | grep -q 'cluster_state:ok'"
wait_for sh -c "docker exec redis-sentinel $cli -p 26380 sentinel get-master-addr-by-name querybara-master | grep -q 63790"
echo "MongoDB $mongo_tag and $redis_image are ready"
