// The sandbox backend, chosen explicitly (docs/sandbox): just-bash is a
// pure-JS simulated shell with a virtual filesystem that eve keeps under
// <project>/.eve/sandbox-cache (the platform relocates it to /app/state/
// sandbox-cache so it survives rebuilds and is in every backup). It needs
// no daemon or KVM - the only backend that runs inside a plain pod - and
// it is NOT isolation: no real binaries, no network policy. Real sandbox
// isolation for Eve agents is on the platform roadmap.
import { defineSandbox } from "eve/sandbox";
import { justbash } from "eve/sandbox/just-bash";

export default defineSandbox({
  backend: justbash(),
});
