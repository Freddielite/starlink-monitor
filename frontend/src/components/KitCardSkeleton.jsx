// Mirrors KitCard's real layout (title line, three axis slots, footer)
// so the loading state doesn't reflow when data swaps in - the
// placeholders just become content in the same spots.
export default function KitCardSkeleton() {
  return (
    <div className="sl-panel sl-kit-card" aria-hidden="true">
      <div className="sl-kit-card__head">
        <div className="sl-skeleton" style={{ width: "45%", height: 14 }} />
        <div className="sl-skeleton" style={{ width: "30%", height: 10, marginTop: 6 }} />
      </div>
      <div className="sl-axes">
        {[0, 1, 2].map((i) => (
          <div className="sl-axis" key={i}>
            <div className="sl-skeleton" style={{ width: 44, height: 8 }} />
            <div className="sl-skeleton" style={{ width: 62, height: 14, marginTop: 7 }} />
            <div className="sl-skeleton" style={{ width: 38, height: 8, marginTop: 6 }} />
          </div>
        ))}
      </div>
      <div className="sl-kit-card__foot">
        <div className="sl-skeleton" style={{ width: 96, height: 9 }} />
      </div>
    </div>
  );
}
