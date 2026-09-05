// The avatar gallery (#426 carried): the ONE place animation is the
// content, so reduced-motion inverts into per-tile opt-in play. The
// copy-code hands an operator the `display.icon` value - selection
// happens in infrastructure, never as a browser preference.
import { React, SDK } from "../../sdk";
import { API } from "../../api";
import { EmptyState, Icon } from "../../primitives";
import "./utility.css";


export function AvatarGallery() {
  const [avatars, setAvatars] = React.useState<{ id: string }[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  // Reactive environment read (the anti-pattern list bans the module-
  // scope one-shot).
  const [reduced, setReduced] = React.useState(false);
  const [playing, setPlaying] = React.useState<ReadonlySet<string>>(new Set());
  React.useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  React.useEffect(() => {
    let dead = false;
    SDK.fetchJSON(`${API}/nexus/assets/avatars`).then(
      (d) => {
        if (!dead) setAvatars(((d as { avatars?: { id: string }[] })?.avatars) ?? []);
      },
      () => {
        if (!dead) setFailed(true);
      },
    );
    return () => {
      dead = true;
    };
  }, []);

  const head = (
    <header className="nx-view-head">
      <h1 className="nx-h1">Avatars</h1>
      <p className="nx-lede">
        An agent wears one by declaring <code>display.icon: &lt;code&gt;</code> in its dashboard
        components — never a browser preference.
      </p>
    </header>
  );
  if (failed) {
    return (
      <div className="nx-ut">
        {head}
        <EmptyState
          title="The avatar library is not being served here."
          description="The library rides a configured gitops repository; demo mode and a first run have none to serve."
        />
      </div>
    );
  }
  if (avatars === null) {
    return (
      <div className="nx-ut" aria-busy="true">
        {head}
        <p className="nx-state">Loading the library…</p>
      </div>
    );
  }
  if (avatars.length === 0) {
    return (
      <div className="nx-ut">
        {head}
        <EmptyState title="No avatars in the library." />
      </div>
    );
  }

  return (
    <div className="nx-ut">
      {head}
      <div className="nx-ava-grid">
        {avatars.map((a) => {
          const still = reduced && !playing.has(a.id);
          return (
            <figure key={a.id} className="nx-ava-tile">
              <img
                src={`${API}/nexus/assets/avatars/${encodeURIComponent(a.id)}${still ? "-still" : ""}`}
                alt={a.id}
                loading="lazy"
              />
              <figcaption>
                <button
                  type="button"
                  onClick={() => {
                    try {
                      navigator.clipboard?.writeText(a.id);
                    } catch {
                      // the code is visible either way
                    }
                    setCopied(a.id);
                    setTimeout(() => setCopied((c) => (c === a.id ? null : c)), 1400);
                  }}
                >
                  {copied === a.id ? "copied" : a.id}
                </button>
                {reduced ? (
                  <button
                    type="button"
                    aria-label={`Play ${a.id}`}
                    onClick={() =>
                      setPlaying((p) => {
                        const next = new Set(p);
                        if (next.has(a.id)) next.delete(a.id);
                        else next.add(a.id);
                        return next;
                      })
                    }
                  >
                    <Icon name={playing.has(a.id) ? "pause" : "play"} />
                  </button>
                ) : null}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
