import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  encodeCursor,
  parseListQuery,
  parseSteamId,
  validateSubmitBan,
} from '../src/validation';

const NOW = '2026-10-01T00:00:00.000Z';
const STEAM = '76561198000000001';

function base(overrides: Record<string, unknown> = {}) {
  return {
    steam_id: STEAM,
    reason: 'cheat',
    permanent: true,
    ...overrides,
  };
}

describe('validateSubmitBan', () => {
  it('computes expires_at from duration_days for temporary bans', () => {
    const result = validateSubmitBan(base({ permanent: false, duration_days: 7 }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.permanent).toBe(false);
    expect(result.value.duration_days).toBe(7);
    expect(result.value.expires_at).toBe('2026-10-08T00:00:00.000Z');
  });

  it('rejects a permanent ban that also carries duration_days', () => {
    const result = validateSubmitBan(base({ duration_days: 7 }), NOW);
    expect(result).toMatchObject({ ok: false, code: 'invalid_duration' });
  });

  it('requires duration_days for temporary bans', () => {
    const result = validateSubmitBan(base({ permanent: false }), NOW);
    expect(result).toMatchObject({ ok: false, code: 'invalid_duration' });
  });

  it('requires a note for ownreason', () => {
    const result = validateSubmitBan(base({ reason: 'ownreason' }), NOW);
    expect(result).toMatchObject({ ok: false, code: 'invalid_request' });
  });

  it('accepts ownreason when a note is present', () => {
    const result = validateSubmitBan(base({ reason: 'ownreason', note: 'impersonating staff' }), NOW);
    expect(result.ok).toBe(true);
  });

  it('rejects unknown reasons', () => {
    const result = validateSubmitBan(base({ reason: 'griefing' }), NOW);
    expect(result).toMatchObject({ ok: false, code: 'invalid_reason' });
  });

  it('rejects malformed SteamIDs', () => {
    for (const steamId of ['123', '7656119800000000', '76561198000000001x', 76561198000000001]) {
      const result = validateSubmitBan(base({ steam_id: steamId }), NOW);
      expect(result).toMatchObject({ ok: false, code: 'invalid_steam_id' });
    }
  });

  it('rejects non-http evidence links', () => {
    const result = validateSubmitBan(base({ evidence_url: 'javascript:alert(1)' }), NOW);
    expect(result).toMatchObject({ ok: false, code: 'invalid_evidence_url' });
  });

  it('normalises blank optional fields to null', () => {
    const result = validateSubmitBan(base({ note: '   ', player_name: '' }), NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.note).toBeNull();
    expect(result.value.player_name).toBeNull();
  });
});

describe('parseListQuery', () => {
  it('parses filters, clamps the page size and keeps status=all', () => {
    const query = parseListQuery(
      new URLSearchParams(
        `status=all&reason=cheat,racism&steam_id=${STEAM}&permanent=true&limit=9999`,
      ),
    );

    expect(query.status).toBe('all');
    expect(query.reasons).toEqual(['cheat', 'racism']);
    expect(query.steamIds).toEqual([STEAM]);
    expect(query.permanent).toBe(true);
    expect(query.limit).toBe(500);
  });

  it('defaults to active bans ordered for delta sync', () => {
    const query = parseListQuery(new URLSearchParams());
    expect(query.status).toBe('active');
    expect(query.limit).toBe(100);
    expect(query.since).toBeNull();
    expect(query.cursor).toBeNull();
  });

  it('rejects an unknown status', () => {
    expect(() => parseListQuery(new URLSearchParams('status=deleted'))).toThrowError(
      /status must be one of/,
    );
  });
});

describe('cursors', () => {
  it('round trips updated_at and id', () => {
    const cursor = encodeCursor('2026-10-01T00:00:00.000Z', 'ban_abc');
    expect(decodeCursor(cursor)).toEqual({ updatedAt: '2026-10-01T00:00:00.000Z', id: 'ban_abc' });
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrowError(/valid pagination cursor/);
  });
});

describe('parseSteamId', () => {
  it('trims and accepts a 17 digit id', () => {
    expect(parseSteamId(` ${STEAM} `)).toBe(STEAM);
  });
});
