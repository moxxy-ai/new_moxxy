import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  useDesks,
  slugifyDeskId,
  nextSwatch,
  type Desk,
} from './desks';
import { mockTauri } from '@/__mocks__/tauri';

vi.mock('@/lib/tauri', () => import('@/__mocks__/tauri'));

const exampleDesk: Desk = {
  id: 'personal',
  name: 'Personal',
  dir: '/Users/me/notes',
  color: '#818cf8',
};

describe('slugifyDeskId', () => {
  it.each([
    ['Personal', 'personal'],
    ['My Workspace', 'my-workspace'],
    ['  hello  ', 'hello'],
    ['Test_123', 'test_123'],
    ['💩emoji', 'emoji'],
    ['---weird---', 'weird'],
  ])('slugifies %j -> %j', (input, expected) => {
    expect(slugifyDeskId(input)).toBe(expected);
  });

  it('caps at 64 characters', () => {
    const long = 'a'.repeat(200);
    expect(slugifyDeskId(long).length).toBe(64);
  });
});

describe('nextSwatch', () => {
  it('rotates through the palette', () => {
    const palette = ['#a', '#b', '#c'];
    expect(nextSwatch([], palette)).toBe('#a');
    expect(nextSwatch([exampleDesk], palette)).toBe('#b');
    expect(nextSwatch([exampleDesk, exampleDesk], palette)).toBe('#c');
    expect(nextSwatch([exampleDesk, exampleDesk, exampleDesk], palette)).toBe('#a');
  });

  it('returns a default when no swatches are provided', () => {
    expect(nextSwatch([], [])).toBe('#818cf8');
  });
});

describe('useDesks', () => {
  beforeEach(() => {
    mockTauri.reset();
    mockTauri.respond('desks_list', () => []);
    mockTauri.respond('desks_active', () => null);
  });

  it('loads the empty list on mount', async () => {
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.desks).toEqual([]);
    expect(result.current.active).toBeNull();
  });

  it('captures errors from desks_list', async () => {
    mockTauri.respond('desks_list', () => {
      throw new Error('json corrupt');
    });
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.error).toBe('json corrupt'));
  });

  it('refreshes after create', async () => {
    const stored: Desk[] = [];
    mockTauri.respond('desks_list', () => stored);
    mockTauri.respond('desks_active', () => null);
    mockTauri.respond('desks_upsert', (args) => {
      stored.push((args as { desk: Desk }).desk);
      return null;
    });
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.create(exampleDesk);
    });
    await waitFor(() => expect(result.current.desks.length).toBe(1));
    expect(result.current.desks[0]).toMatchObject({ id: 'personal' });
  });

  it('removes and refreshes', async () => {
    const stored: Desk[] = [exampleDesk];
    mockTauri.respond('desks_list', () => stored);
    mockTauri.respond('desks_active', () => null);
    mockTauri.respond('desks_remove', (args) => {
      const idx = stored.findIndex((d) => d.id === (args as { id: string }).id);
      if (idx >= 0) stored.splice(idx, 1);
      return null;
    });
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.desks.length).toBe(1));
    await act(async () => {
      await result.current.remove('personal');
    });
    await waitFor(() => expect(result.current.desks.length).toBe(0));
  });

  it('sets active and refreshes', async () => {
    let activeId: string | null = null;
    mockTauri.respond('desks_list', () => [exampleDesk]);
    mockTauri.respond('desks_active', () => activeId);
    mockTauri.respond('desks_set_active', (args) => {
      activeId = (args as { id: string }).id;
      return null;
    });
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.setActive('personal');
    });
    await waitFor(() => expect(result.current.active).toBe('personal'));
  });

  it('pickFolder forwards the picker result', async () => {
    mockTauri.respond('desks_pick_folder', () => '/Users/me/notes');
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const picked = await result.current.pickFolder();
    expect(picked).toBe('/Users/me/notes');
  });

  it('pickFolder returns null when the user cancels', async () => {
    mockTauri.respond('desks_pick_folder', () => null);
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(await result.current.pickFolder()).toBeNull();
  });
});
