import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderHook } from '@testing-library/react';
import { DeskSidebar } from './desk-sidebar';
import { useDesks } from '@/lib/desks';
import { mockTauri } from '@/__mocks__/tauri';

vi.mock('@/lib/tauri', () => import('@/__mocks__/tauri'));

const personal = {
  id: 'personal',
  name: 'Personal',
  dir: '/Users/me/notes',
  color: '#818cf8',
};

const work = {
  id: 'work',
  name: 'Work',
  dir: '/Users/me/work',
  color: '#22d3ee',
};

async function setupApi(
  initialDesks: typeof personal[],
  activeId: string | null = null,
) {
  const desks = [...initialDesks];
  let active: string | null = activeId;
  mockTauri.respond('desks_list', () => desks);
  mockTauri.respond('desks_active', () => active);
  mockTauri.respond('desks_set_active', (args) => {
    active = (args as { id: string }).id;
    return null;
  });
  mockTauri.respond('desks_remove', (args) => {
    const idx = desks.findIndex((d) => d.id === (args as { id: string }).id);
    if (idx >= 0) desks.splice(idx, 1);
    return null;
  });
  mockTauri.respond('desks_upsert', (args) => {
    const incoming = (args as { desk: typeof personal }).desk;
    const idx = desks.findIndex((d) => d.id === incoming.id);
    if (idx >= 0) desks[idx] = incoming;
    else desks.push(incoming);
    return null;
  });

  const { result } = renderHook(() => useDesks());
  await waitFor(() => expect(result.current.loading).toBe(false));
  return result;
}

describe('<DeskSidebar />', () => {
  beforeEach(() => {
    mockTauri.reset();
    mockTauri.respond('desks_list', () => []);
    mockTauri.respond('desks_active', () => null);
  });

  it('renders an empty state with the "new desk" button', async () => {
    const result = await setupApi([]);
    render(<DeskSidebar api={result.current} />);
    expect(screen.getByTestId('desk-sidebar-new')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).toBeNull();
  });

  it('renders a row per desk with the active row highlighted', async () => {
    const result = await setupApi([personal, work], 'personal');
    const { rerender } = render(<DeskSidebar api={result.current} />);
    expect(screen.getByTestId('desk-row-personal')).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByTestId('desk-row-work')).toHaveAttribute(
      'data-active',
      'false',
    );
    // re-render with new api object to keep types happy
    rerender(<DeskSidebar api={result.current} />);
  });

  it('switches active desk on row click', async () => {
    const result = await setupApi([personal, work], 'personal');
    const { rerender } = render(<DeskSidebar api={result.current} />);
    await userEvent.click(screen.getByTestId('desk-row-work'));
    await waitFor(() => expect(result.current.active).toBe('work'));
    rerender(<DeskSidebar api={result.current} />);
    expect(screen.getByTestId('desk-row-work')).toHaveAttribute(
      'data-active',
      'true',
    );
  });

  it('removes a desk after confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const result = await setupApi([personal, work]);
    const { rerender } = render(<DeskSidebar api={result.current} />);

    // Hover to reveal the remove button.
    await userEvent.hover(screen.getByTestId('desk-row-work'));
    await userEvent.click(screen.getByTestId('desk-row-remove-work'));
    await waitFor(() => expect(result.current.desks.length).toBe(1));
    rerender(<DeskSidebar api={result.current} />);
    expect(screen.queryByTestId('desk-row-work')).toBeNull();
    confirmSpy.mockRestore();
  });

  it('keeps the desk when the user cancels the confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const result = await setupApi([personal]);
    render(<DeskSidebar api={result.current} />);
    await userEvent.hover(screen.getByTestId('desk-row-personal'));
    await userEvent.click(screen.getByTestId('desk-row-remove-personal'));
    // Refresh hasn't happened, list still has one.
    expect(result.current.desks.length).toBe(1);
    confirmSpy.mockRestore();
  });

  it('creates a desk via the folder picker + prompt flow', async () => {
    mockTauri.respond('desks_pick_folder', () => '/Users/me/blocky');
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('blocky');
    const result = await setupApi([]);
    const { rerender } = render(<DeskSidebar api={result.current} />);

    await userEvent.click(screen.getByTestId('desk-sidebar-new'));
    await waitFor(() => expect(result.current.desks.length).toBe(1));
    expect(result.current.desks[0]).toMatchObject({
      id: 'blocky',
      name: 'blocky',
      dir: '/Users/me/blocky',
    });
    rerender(<DeskSidebar api={result.current} />);
    promptSpy.mockRestore();
  });

  it('abandons creation if the user cancels the picker', async () => {
    mockTauri.respond('desks_pick_folder', () => null);
    const result = await setupApi([]);
    render(<DeskSidebar api={result.current} />);
    await userEvent.click(screen.getByTestId('desk-sidebar-new'));
    // No desk added, no errors raised.
    expect(result.current.desks.length).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('surfaces errors from the store as a banner', async () => {
    mockTauri.respond('desks_list', () => {
      throw new Error('disk full');
    });
    const { result } = renderHook(() => useDesks());
    await waitFor(() => expect(result.current.error).toBe('disk full'));
    render(<DeskSidebar api={result.current} />);
    expect(screen.getByRole('alert')).toHaveTextContent('disk full');
  });
});
