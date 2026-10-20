/**
 * A scan anywhere on the screen (decision 0096 follow-up): with the cursor outside every field and
 * no window open, a scanner's fast keys and Enter reach the screen's search, in Latin letters, and
 * the Enter does not press the button that has the focus. A person typing, a key in a field, or a
 * scan while a window is open is left alone. A scanner without Enter ends with a pause.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGlobalScan } from '../../src/features/items/scan';

function Screen(props: { onScan: (code: string) => void; onPress?: () => void }) {
  useGlobalScan(props.onScan);
  return (
    <div>
      <input aria-label="field" />
      <button type="button" onClick={props.onPress}>
        Pay
      </button>
    </div>
  );
}

/** Keys at a scanner's speed (all in a few milliseconds), then Enter if asked. */
function scanKeys(target: Element, keys: string[], enter = true) {
  for (const key of keys) fireEvent.keyDown(target, { key });
  if (enter) return fireEvent.keyDown(target, { key: 'Enter' });
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('a scan anywhere on the screen', () => {
  it('reaches the search, and its Enter does not press the focused button', () => {
    const onScan = vi.fn();
    const onPress = vi.fn();
    render(<Screen onScan={onScan} onPress={onPress} />);
    const pay = screen.getByRole('button', { name: 'Pay' });
    pay.focus();
    const notCancelled = scanKeys(pay, [...'6291041500213']);
    expect(onScan).toHaveBeenCalledWith('6291041500213');
    expect(notCancelled).toBe(false);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('comes back in Latin letters when Windows is on the Arabic keyboard', () => {
    const onScan = vi.fn();
    render(<Screen onScan={onScan} />);
    scanKeys(document.body, ['لإ', 'ُ', 'ٍ', 'لإ', '-', '1', '2', '3', '4']);
    expect(onScan).toHaveBeenCalledWith('TEST-1234');
  });

  it('leaves alone keys in a field, and any scan while a window is open', () => {
    const onScan = vi.fn();
    render(<Screen onScan={onScan} />);
    scanKeys(screen.getByLabelText('field'), [...'6291041500213']);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    document.body.appendChild(dialog);
    scanKeys(document.body, [...'6291041500213']);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('leaves alone a person typing (slower than a scanner)', async () => {
    const onScan = vi.fn();
    render(<Screen onScan={onScan} />);
    for (const key of '1234') {
      fireEvent.keyDown(document.body, { key });
      await sleep(70);
    }
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(onScan).not.toHaveBeenCalled();
  });

  it('a scanner set up without Enter: the pause ends the scan', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const onScan = vi.fn();
    render(<Screen onScan={onScan} />);
    scanKeys(document.body, [...'CHEM-0013'], false);
    expect(onScan).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(onScan).toHaveBeenCalledWith('CHEM-0013');
  });
});
