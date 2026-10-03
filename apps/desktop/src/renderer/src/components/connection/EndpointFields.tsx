import { useWatch } from 'react-hook-form';

import {
  defaultHostRow,
  defaultSentinelRow,
  type DialogEngine,
  type FormEndpointKind,
} from '../../state/connection-form';
import { Field, Input } from '../ui';
import { HostListField } from './HostListField';
import { UrlListField } from './UrlListField';
import { Note, type ConnectionForm } from './fields';

/** How each endpoint form reads in the "Connect with" list. */
export const ENDPOINT_LABELS: Readonly<Record<FormEndpointKind, string>> = {
  host: 'Host and port',
  socket: 'Unix socket',
  uri: 'Connection URI',
  hosts: 'Host list (replica set)',
  srv: 'SRV record (mongodb+srv)',
  sentinel: 'Sentinel',
  cluster: 'Cluster',
  urls: 'Node URLs',
  cloudId: 'Cloud ID (Elastic Cloud)',
};

/** A pasted-URI example per engine, with a password to show where it goes. */
export const URI_EXAMPLES: Readonly<Record<DialogEngine, string>> = {
  postgres: 'postgresql://user:password@host:5432/database?sslmode=require',
  mysql: 'mysql://user:password@host:3306/database',
  mariadb: 'mariadb://user:password@host:3306/database',
  mongodb: 'mongodb+srv://user:password@cluster0.example.net/database',
  redis: 'rediss://user:password@host:6380/0',
  elasticsearch: 'https://elastic:password@host:9200',
};

/** The same, without the password, for the stored URI field. */
const STORED_URI_EXAMPLES: Readonly<Record<DialogEngine, string>> = {
  postgres: 'postgresql://user@host:5432/database?sslmode=require',
  mysql: 'mysql://user@host:3306/database',
  mariadb: 'mariadb://user@host:3306/database',
  mongodb: 'mongodb://user@host1:27017,host2:27017/database?replicaSet=rs0',
  redis: 'redis://user@host:6379/0',
  elasticsearch: 'https://host:9200',
};

const SOCKET_EXAMPLES: Readonly<Record<DialogEngine, string>> = {
  postgres: '/var/run/postgresql',
  mysql: '/var/run/mysqld/mysqld.sock',
  mariadb: '/run/mysqld/mysqld.sock',
  mongodb: '/tmp/mongodb-27017.sock',
  redis: '/var/run/redis/redis-server.sock',
  elasticsearch: '',
};

/** The inputs of the chosen endpoint form: host and port, socket, URI, host lists, SRV. */
export function EndpointFields(props: {
  readonly form: ConnectionForm;
  readonly engine: DialogEngine;
  readonly kind: FormEndpointKind;
}) {
  const { form, engine, kind } = props;
  const { register, control, formState } = form;
  const errors = formState.errors;
  const uri = useWatch({ control, name: 'uri' });
  switch (kind) {
    case 'host':
      return (
        <>
          <Field label="Host" htmlFor="cx-host" error={errors.host?.message}>
            <Input id="cx-host" {...register('host')} aria-invalid={!!errors.host} />
          </Field>
          <Field label="Port" htmlFor="cx-port" error={errors.port?.message}>
            <Input
              id="cx-port"
              inputMode="numeric"
              {...register('port')}
              aria-invalid={!!errors.port}
            />
          </Field>
        </>
      );
    case 'socket':
      return (
        <Field
          label="Socket path"
          htmlFor="cx-socket"
          error={errors.socketPath?.message}
          className="col-span-2"
        >
          <Input
            id="cx-socket"
            placeholder={SOCKET_EXAMPLES[engine]}
            {...register('socketPath')}
            aria-invalid={!!errors.socketPath}
          />
        </Field>
      );
    case 'uri':
      return (
        <>
          <Field
            label="URI (without the password)"
            htmlFor="cx-uri"
            error={errors.uri?.message}
            className="col-span-2"
          >
            <Input
              id="cx-uri"
              placeholder={STORED_URI_EXAMPLES[engine]}
              {...register('uri')}
              aria-invalid={!!errors.uri}
            />
          </Field>
          {engine === 'redis' && /^rediss:/i.test(uri) && (
            <Note>rediss:// connects with TLS, configured on the TLS tab.</Note>
          )}
        </>
      );
    case 'srv':
      return (
        <>
          <Field
            label="SRV host name"
            htmlFor="cx-host"
            error={errors.host?.message}
            className="col-span-2"
          >
            <Input
              id="cx-host"
              placeholder="cluster0.example.net"
              {...register('host')}
              aria-invalid={!!errors.host}
            />
          </Field>
          <Note>
            Querybara looks up the hosts (the _mongodb._tcp SRV record) and default options in DNS,
            as a mongodb+srv:// URI does, and connects with TLS unless you turn it off on the TLS
            tab. The lookup happens on this computer, also when the servers are reached through an
            SSH tunnel or a proxy.
          </Note>
        </>
      );
    case 'hosts':
      return (
        <>
          <HostListField
            form={form}
            name="hostList"
            label="Hosts"
            rowLabel="Host"
            newRow={() => defaultHostRow(engine)}
            hint="Any members of the replica set; the driver finds the others."
          />
          <Field
            label="Replica set"
            htmlFor="cx-replica-set"
            hint="Optional, e.g. rs0"
            error={errors.replicaSet?.message}
          >
            <Input id="cx-replica-set" {...register('replicaSet')} />
          </Field>
          <div />
        </>
      );
    case 'cluster':
      return (
        <>
          <HostListField
            form={form}
            name="hostList"
            label="Seed nodes"
            rowLabel="Seed"
            newRow={() => defaultHostRow(engine)}
            hint="Any reachable nodes; Querybara discovers the rest of the cluster from them."
          />
          <Note>A cluster has only database 0.</Note>
        </>
      );
    case 'sentinel':
      return (
        <>
          <HostListField
            form={form}
            name="sentinels"
            label="Sentinels"
            rowLabel="Sentinel"
            newRow={defaultSentinelRow}
            hint="Querybara asks them for the current master."
          />
          <Field label="Master name" htmlFor="cx-master-name" error={errors.masterName?.message}>
            <Input
              id="cx-master-name"
              placeholder="mymaster"
              {...register('masterName')}
              aria-invalid={!!errors.masterName}
            />
          </Field>
          <div />
        </>
      );
    case 'urls':
      return <UrlListField form={form} />;
    case 'cloudId':
      return (
        <>
          <Field
            label="Cloud ID"
            htmlFor="cx-cloud-id"
            error={errors.cloudId?.message}
            className="col-span-2"
          >
            <Input
              id="cx-cloud-id"
              placeholder="deployment:ZXUtd2VzdC0xLmF3cy5mb3VuZC5pbyRjZWM2ZjI2MWE3NGJmMjRjZTMzYmI4ODExYjg0Mjk0ZiQ="
              {...register('cloudId')}
              aria-invalid={!!errors.cloudId}
            />
          </Field>
          <Note>
            From the deployment page in Elastic Cloud. Querybara connects to its Elasticsearch
            endpoint over TLS.
          </Note>
        </>
      );
  }
}
