// The communication doc, fetched ONCE and shared: Alert Routing renders
// it and the canvas badge layer joins against its edges. Carried
// semantics from the view-local original: demo seeds the fixture and
// never fetches; a 404 (view withheld) or 503 (no records) leaves null
// and the consumer states that honestly.
import { React, SDK } from "../sdk";
import { API } from "../api";
import { DEMO_COMM, DEMO_COMM_HISTORY } from "./demo";
import type { CommHistoryDoc, CommunicationDoc } from "../app/communication/model";

export function useCommDoc(demo: boolean): CommunicationDoc | null {
  const [doc, setDoc] = React.useState<CommunicationDoc | null>(demo ? (DEMO_COMM as CommunicationDoc) : null);
  React.useEffect(() => {
    if (demo) return;
    let dead = false;
    SDK.fetchJSON(`${API}/nexus/communication`).then(
      (d) => {
        if (!dead) setDoc(d as CommunicationDoc);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [demo]);
  return doc;
}

/** The history sibling (`/nexus/communication/history?window=…`): same
 * contract as the doc - demo seeds the fixture and never fetches, a
 * failed fetch leaves null and the consumer states that honestly. A
 * window change refetches. */
export function useCommHistory(demo: boolean, window: "1h" | "24h" | "7d"): CommHistoryDoc | null {
  const [doc, setDoc] = React.useState<CommHistoryDoc | null>(demo ? (DEMO_COMM_HISTORY as CommHistoryDoc) : null);
  React.useEffect(() => {
    if (demo) return;
    let dead = false;
    SDK.fetchJSON(`${API}/nexus/communication/history?window=${window}`).then(
      (d) => {
        if (!dead) setDoc(d as CommHistoryDoc);
      },
      () => {},
    );
    return () => {
      dead = true;
    };
  }, [demo, window]);
  return doc;
}
