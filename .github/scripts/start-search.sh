#!/usr/bin/env bash
# Starts the search servers the integration and end-to-end tests use: Elasticsearch with
# security on (user elastic, password joinery-es, plain HTTP) on port 9200, and OpenSearch
# without its security plugin on port 9201. Both are single nodes with a snapshot directory
# (path.repo) and the disk watermarks off, as plain containers on the host network like the
# NoSQL servers.
#
# Usage: start-search.sh <elasticsearch tag> <opensearch tag>, e.g. start-search.sh 9.5.3 3.8.0
set -euo pipefail
es_tag=${1:?Elasticsearch image tag}
os_tag=${2:?OpenSearch image tag}
es_major=${es_tag%%.*}

wait_for() {
  for _ in $(seq 1 180); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "Timed out waiting for: $*" >&2
  return 1
}

# Elasticsearch and OpenSearch map their indices with mmap.
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

docker run -d --name opensearch --network host \
  -e cluster.name=joinery-os \
  -e node.name=os1 \
  -e discovery.type=single-node \
  -e network.host=127.0.0.1 \
  -e http.port=9201 \
  -e transport.port=9301 \
  -e path.repo=/tmp/snapshots \
  -e cluster.routing.allocation.disk.threshold_enabled=false \
  -e DISABLE_SECURITY_PLUGIN=true \
  -e DISABLE_INSTALL_DEMO_CONFIG=true \
  -e 'OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m' \
  "opensearchproject/opensearch:$os_tag"

wait_for curl -fsS -u elastic:joinery-es \
  'http://127.0.0.1:9200/_cluster/health?wait_for_status=yellow&timeout=1s'
wait_for curl -fsS 'http://127.0.0.1:9201/_cluster/health?wait_for_status=yellow&timeout=1s'
echo "Elasticsearch $es_tag and OpenSearch $os_tag are ready"
