import {Readable} from 'node:stream';
import {describe, expect, it, vi} from 'vitest';
import DashboardPoolApi from '../src/dashboard/pool-api.js';
import {HttpError} from '../src/control/http.js';

const upstream = vi.hoisted(() => vi.fn());
vi.mock('got', () => ({default: upstream}));
const GUILD = '123456789012345678';
const fixture = (options: {authorized?: boolean; csrf?: boolean; session?: boolean} = {}) => {
  const session = {csrfToken: 'test'};
  const auth = {
    requireSession: vi.fn(() => { if (options.session === false) throw new HttpError(401, 'auth'); return session; }),
    assertCsrf: vi.fn(() => { if (options.csrf === false) throw new HttpError(403, 'csrf'); }),
    assertMutationAllowed: vi.fn(),
    manageableGuilds: vi.fn(async () => options.authorized === false ? [] : [{id: GUILD}]),
  };
  const orchestrator = {guilds: vi.fn(async () => ({guilds: [{id: GUILD}]}))};
  const api = new DashboardPoolApi({publicUrl: new URL('https://music.example.test'),
    orchestratorUrl: 'http://orchestrator:3100', orchestratorToken: 'private-token'} as never, auth as never, orchestrator as never);
  const req = Object.assign(Readable.from(['{"defaultGroupId":null}']), {
    method: 'PATCH', url: `/api/guilds/${GUILD}/routing`, headers: {},
  });
  const res = {writeHead: vi.fn(), end: vi.fn()};
  upstream.mockReset();
  return {api, auth, req, res};
};

describe('dashboard routing authorization', () => {
  it('rejects a missing OAuth session without calling the orchestrator', async () => {
    const {api, req, res} = fixture({session: false});
    await expect(api.handle(req as never, res as never)).rejects.toMatchObject({statusCode: 401});
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects CSRF before expensive guild permission refresh', async () => {
    const {api, auth, req, res} = fixture({csrf: false});
    await expect(api.handle(req as never, res as never)).rejects.toMatchObject({statusCode: 403});
    expect(auth.manageableGuilds).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects guilds the user does not administer', async () => {
    const {api, req, res} = fixture({authorized: false});
    await expect(api.handle(req as never, res as never)).rejects.toMatchObject({statusCode: 403});
    expect(upstream).not.toHaveBeenCalled();
  });
  it('refreshes permissions and forwards an authorized patch without exposing its token', async () => {
    const {api, auth, req, res} = fixture();
    upstream.mockResolvedValue({statusCode: 200, body: {guildId: GUILD,
      routing: {defaultGroupId: null, channelGroups: {}, categoryGroups: {}}}});
    expect(await api.handle(req as never, res as never)).toBe(true);
    expect(auth.manageableGuilds).toHaveBeenCalledWith(expect.anything(), true);
    expect(auth.assertMutationAllowed).toHaveBeenCalledOnce();
    expect(String(res.end.mock.calls[0][0])).not.toContain('private-token');
  });
  it('rejects an upstream response scoped to another guild', async () => {
    const {api, req, res} = fixture();
    upstream.mockResolvedValue({statusCode: 200, body: {guildId: '999999999999999999'}});
    await expect(api.handle(req as never, res as never)).rejects.toMatchObject({statusCode: 502});
  });
});
