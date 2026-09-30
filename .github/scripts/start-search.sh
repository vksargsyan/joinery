#!/usr/bin/env bash
# Starts the Elasticsearch server the integration and end-to-end tests use: security on (user
# elastic, password joinery-es, plain HTTP) on port 9200, a single node with a snapshot
# directory (path.repo) and the disk watermarks off, as a plain container on the host network
# like the NoSQL servers.
#
# Usage: start-search.sh <elasticsearch tag>, e.g. start-search.sh 9.5.3
set -euo pipefail
es_tag=${1:?Elasticsearch image tag}
es_major=${es_tag%%.*}

wait_for() {
  for _ in $(seq 1 180); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for: $*" >&2
  return 1
}

# Elasticsearch maps its indices with mmap.
sudo sysctl -w vm.max_map_count=262144

es_settings=(
  -e cluster.name=joinery-es
  -e node.name=es1
  -e discovery.type=single-node
  -e network.host=127.0.0.1
  -e http.port=9200
  -e transport.port=9300
  -e path.repo=/tmp/snapshots
  -e ELASTIC_PASSWORD=joinery-es
  -e xpack.security.enabled=true
  -e xpack.security.http.ssl.enabled=false
  -e xpack.security.transport.ssl.enabled=false
  -e xpack.ml.enabled=false
  -e ingest.geoip.downloader.enabled=false
  -e cluster.routing.allocation.disk.threshold_enabled=false
  -e 'ES_JAVA_OPTS=-Xms512m -Xmx512m'
)
# Enrollment tokens exist from 8.0; 7.x refuses the unknown setting.
if [ "$es_major" -ge 8 ]; then es_settings+=(-e xpack.security.enrollment.enabled=false); fi
docker run -d --name elasticsearch --network host "${es_settings[@]}" \
  "docker.elastic.co/elasticsearch/elasticsearch:$es_tag"

wait_for curl -fsS -u elastic:joinery-es \
  'http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=1s'
echo "Elasticsearch $es_tag is ready"
