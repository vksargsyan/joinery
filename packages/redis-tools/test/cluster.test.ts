import { describe, expect, it } from 'vitest';

import {
  crc16,
  keySlot,
  nodeAddress,
  parseClusterNodes,
  parseClusterShards,
  uncoveredSlots,
} from '../src';
import { enc, recorded, recordedText } from './fixtures';

describe('keySlot', () => {
  it('matches CLUSTER KEYSLOT', () => {
    expect(crc16(enc('123456789'))).toBe(0x31c3);
    expect(keySlot('foo')).toBe(12182);
    expect(keySlot('{user1000}.following')).toBe(3443);
    expect(keySlot('{user1000}.followers')).toBe(3443);
    expect(keySlot('a{}b')).toBe(13694);
    expect(keySlot('querybara:it:x')).toBe(3380);
    expect(keySlot(Uint8Array.of(0xff, 0x00))).toBeLessThan(16384);
  });
});

describe('cluster topology', () => {
  it('parses a real CLUSTER NODES', () => {
    const nodes = parseClusterNodes(recordedText('cluster-nodes-7.0.resp'));
    expect(nodes).toHaveLength(3);
    const myself = nodes.find((n) => n.myself)!;
    expect(myself).toMatchObject({
      host: '127.0.0.1',
      port: 7100,
      busPort: 17100,
      role: 'primary',
      state: 'connected',
    });
    expect(nodes.map((n) => n.slots)).toEqual(
      expect.arrayContaining([[[0, 5460]], [[5461, 10922]], [[10923, 16383]]]),
    );
    expect(uncoveredSlots(nodes)).toEqual([]);
    expect(nodeAddress(myself)).toBe('127.0.0.1:7100');
  });

  it('parses replicas, hostnames, IPv6 and migrating slots', () => {
    const nodes = parseClusterNodes(
      [
        'a1 10.0.0.1:6379@16379,redis-a.local myself,master - 0 0 1 connected 0-100 200 [300->-b2]',
        'b2 [::1]:6380@16380 slave a1 0 0 1 connected',
        'c3 10.0.0.3:6379@16379 master,fail - 0 0 2 disconnected',
      ].join('\n'),
    );
    expect(nodes[0]).toMatchObject({
      hostname: 'redis-a.local',
      slots: [
        [0, 100],
        [200, 200],
      ],
    });
    expect(nodes[1]).toMatchObject({ host: '::1', port: 6380, role: 'replica', primaryId: 'a1' });
    expect(nodes[2]!.failing).toBe(true);
    expect(nodeAddress(nodes[1]!)).toBe('[::1]:6380');
    expect(uncoveredSlots(nodes)).toEqual([
      [101, 199],
      [201, 16383],
    ]);
  });

  it('parses a real CLUSTER SHARDS', () => {
    const nodes = parseClusterShards(recorded('cluster-shards-7.0.resp'));
    expect(nodes).toHaveLength(3);
    expect(nodes.every((n) => n.role === 'primary' && n.state === 'online')).toBe(true);
    expect(nodes.find((n) => n.port === 7101)!.slots).toEqual([[5461, 10922]]);
    expect(uncoveredSlots(nodes)).toEqual([]);
  });
});
