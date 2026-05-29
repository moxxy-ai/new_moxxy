import { describe, expect, it, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { mockTauri } from '@/__mocks__/tauri';

vi.mock('@/lib/tauri', () => import('@/__mocks__/tauri'));

describe('<App />', () => {
  beforeEach(() => {
    mockTauri.reset();
    mockTauri.respond('runner_ready', () => false);
  });

  it('renders the brand mark in the empty state', () => {
    mockTauri.respond('sidecar_status', () => 'starting');
    render(<App />);
    expect(screen.getByText('moxxy')).toBeInTheDocument();
  });

  it('shows runner status in the sidebar header', async () => {
    mockTauri.respond('sidecar_status', () => 'running');
    render(<App />);
    const label = await screen.findByTestId('runner-status');
    await waitFor(() => expect(label).toHaveTextContent('running'));
  });

  it('switches the hint when the runner is ready', async () => {
    mockTauri.respond('sidecar_status', () => 'running');
    mockTauri.respond('runner_ready', () => true);
    render(<App />);
    expect(
      await screen.findByText(/Type a prompt below/),
    ).toBeInTheDocument();
  });

  it('shows the offline hint when the runner has crashed', async () => {
    mockTauri.respond('sidecar_status', () => 'crashed');
    render(<App />);
    expect(
      await screen.findByText(/Runner offline/),
    ).toBeInTheDocument();
  });

  it('renders user + assistant blocks after sending and receiving chunks', async () => {
    mockTauri.respond('sidecar_status', () => 'running');
    mockTauri.respond('runner_ready', () => true);
    mockTauri.respond('run_turn', () => 'T-1');

    render(<App />);
    await screen.findByText(/Type a prompt below/);

    const input = await screen.findByTestId('composer-input');
    await userEvent.type(input, 'hello there');
    await userEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId('block-user')).toHaveTextContent(
      'hello there',
    );

    act(() => {
      mockTauri.emit('runner.event', { kind: 'chunk', text: 'Hi!' });
      mockTauri.emit('runner.turn.complete', { turnId: 'T-1' });
    });

    expect(await screen.findByTestId('block-assistant')).toHaveTextContent(
      'Hi!',
    );
    // After complete, send button is back.
    expect(screen.getByTestId('composer-send')).toBeInTheDocument();
  });

  it('shows an abort button while a turn is in flight', async () => {
    mockTauri.respond('sidecar_status', () => 'running');
    mockTauri.respond('runner_ready', () => true);
    mockTauri.respond('run_turn', () => 'T-1');

    render(<App />);
    await screen.findByText(/Type a prompt below/);

    const input = await screen.findByTestId('composer-input');
    await userEvent.type(input, 'hi');
    await userEvent.click(screen.getByTestId('composer-send'));

    expect(await screen.findByTestId('composer-abort')).toBeInTheDocument();
    expect(screen.queryByTestId('composer-send')).toBeNull();
  });

  it('shows "New window" on main and opens a session window', async () => {
    mockTauri.respond('sidecar_status', () => 'running');
    mockTauri.respond('runner_ready', () => true);
    mockTauri.respond('open_session_window', () => 'session-abc');
    render(<App />);
    const btn = await screen.findByTestId('open-new-window');
    expect(btn).not.toBeDisabled();
    await userEvent.click(btn);
    await waitFor(() =>
      expect(
        mockTauri.calls.find((c) => c.cmd === 'open_session_window'),
      ).toBeDefined(),
    );
  });

  it('switches to the schedules view via the sidebar nav', async () => {
    mockTauri.respond('sidecar_status', () => 'running');
    mockTauri.respond('runner_ready', () => true);
    mockTauri.respond('schedules_list', () => []);
    render(<App />);
    await userEvent.click(await screen.findByTestId('nav-schedules'));
    expect(await screen.findByTestId('schedule-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('composer')).toBeNull();
  });
});
