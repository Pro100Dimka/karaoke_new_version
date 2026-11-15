import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tr } from '@neo-ui-kit/react';
import { runInAction } from 'mobx';
import { TestRouter } from '../test/QueryProvider';
import { store } from '../providers/store';
import {
  changeRadioStation,
  setRadioStation,
  setRadioVolume,
  setYoutubePlaylist,
  toggleRadio,
} from '../providers/radio';
import { FloatingControls } from './FloatingControls';
import { youtubeSourceFromUrl } from './radioStations';

vi.mock('../pages/library/modals/settings', () => ({ openSettings: vi.fn() }));
vi.mock('../providers/radio', () => ({
  toggleRadio: vi.fn(),
  setRadioVolume: vi.fn(),
  setRadioStation: vi.fn(),
  changeRadioStation: vi.fn(),
  setYoutubePlaylist: vi.fn(() => true),
}));

describe('library music controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runInAction(() => {
      store.online.room = null;
      store.radio.enabled = true;
      store.radio.loading = false;
      store.radio.error = false;
      store.updatePreferences({ radioStation: 'groove-salad' });
    });
  });

  it('keeps the volume reachable when the pointer leaves the launcher', () => {
    render(
      <TestRouter>
        <FloatingControls />
      </TestRouter>,
    );
    const button = screen.getByRole('button', { name: tr('radio') });
    fireEvent.click(button);
    fireEvent.mouseEnter(button);
    fireEvent.mouseLeave(button);
    const slider = screen.getByRole('slider', { name: tr('radioVolume') });
    expect(slider).toBeVisible();
    fireEvent.input(slider, { target: { value: '62' } });
    expect(setRadioVolume).toHaveBeenCalledWith(expect.closeTo(7.24436, 5));
    fireEvent.click(
      screen.getByRole('button', { name: tr('radioNextStation') }),
    );
    expect(changeRadioStation).toHaveBeenCalledWith(1);
  });

  it('shows a playlist selected elsewhere while the music panel is open', () => {
    render(
      <TestRouter>
        <FloatingControls />
      </TestRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: tr('radio') }));
    act(() => {
      store.updatePreferences({
        radioStation: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:2',
      });
    });
    expect(screen.getByRole('tab', { name: 'YouTube' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      screen.getByRole('textbox', { name: tr('radioPlaylistUrl') }),
    ).toHaveValue(
      'https://www.youtube.com/playlist?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
    );
  });

  it('opens one music button without toggling playback and offers direct station selection', () => {
    render(
      <TestRouter>
        <FloatingControls />
      </TestRouter>,
    );
    const launcher = screen.getByRole('button', { name: tr('radio') });
    fireEvent.mouseEnter(launcher);
    expect(
      screen.queryByRole('dialog', { name: tr('radioControls') }),
    ).not.toBeInTheDocument();
    fireEvent.click(launcher);
    expect(toggleRadio).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: /SomaFM · Groove Salad/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(
      screen.getByRole('button', { name: 'KISS FM Dance · EDM' }),
    );
    expect(setRadioStation).toHaveBeenCalledWith('kiss-fm');
    fireEvent.click(screen.getByRole('button', { name: tr('radioPause') }));
    expect(toggleRadio).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: tr('close') }));
    expect(launcher).toHaveAttribute('aria-expanded', 'false');
  });

  it('submits a YouTube playlist from the player and explains an invalid address', () => {
    render(
      <TestRouter>
        <FloatingControls />
      </TestRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: tr('radio') }));
    fireEvent.click(screen.getByRole('tab', { name: 'YouTube' }));
    const input = screen.getByRole('textbox', { name: tr('radioPlaylistUrl') });
    const url =
      'https://youtube.com/playlist?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y';
    fireEvent.change(input, { target: { value: url } });
    fireEvent.click(
      screen.getByRole('button', { name: tr('radioUsePlaylist') }),
    );
    expect(setYoutubePlaylist).toHaveBeenCalledWith(url);
    vi.mocked(setYoutubePlaylist).mockReturnValueOnce(false);
    fireEvent.click(
      screen.getByRole('button', { name: tr('radioUsePlaylist') }),
    );
    expect(screen.getByText(tr('radioPlaylistInvalid'))).toBeVisible();
  });

  it('lets the user browse radio stations without replacing the playing YouTube source', () => {
    act(() => {
      store.updatePreferences({
        radioStation: 'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:2',
      });
    });
    render(
      <TestRouter>
        <FloatingControls />
      </TestRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: tr('radio') }));
    fireEvent.click(screen.getByRole('tab', { name: tr('radio') }));
    expect(
      screen.getByRole('group', { name: tr('radioStation') }),
    ).toBeVisible();
    expect(setRadioStation).not.toHaveBeenCalled();
    expect(toggleRadio).not.toHaveBeenCalled();
  });

  it.each([
    'https://youtube.com/playlist?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
    'https://music.youtube.com/playlist?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
    'https://www.youtube.com/watch?v=QUsg4kgvwBo&list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
  ])('accepts a public playlist address: %s', (url) => {
    expect(youtubeSourceFromUrl(url)).toBe(
      'youtube:PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y:1',
    );
  });

  it.each([
    'https://youtube.com.attacker.test/?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
    'file:///secret?list=PLRBp0Fe2GpglTnOLbhyrHAVaWsCIEX53Y',
    'https://youtube.com/watch?v=QUsg4kgvwBo',
  ])('rejects an unsupported source: %s', (url) => {
    expect(youtubeSourceFromUrl(url)).toBeNull();
  });
});
