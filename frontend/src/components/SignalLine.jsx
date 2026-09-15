// The app's signature rule: a faint signal trace under the header, the
// one decorative element in the interface. Deliberately not a heartbeat
// waveform (what Pulse used) - an arc sweep reads as a dish acquiring,
// which is the right subject here.
export default function SignalLine() {
  return (
    <svg className="sl-signalline" viewBox="0 0 400 28" preserveAspectRatio="none" aria-hidden="true">
      <path d="M0 22 H120 Q170 22 200 6 Q230 22 280 22 H400" />
    </svg>
  );
}
