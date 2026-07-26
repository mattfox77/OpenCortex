# local-dev Profile

Local development profile for non-target machines. This profile may use
developer-local `.env` files and non-Quadlet tooling, but those values must
never be baked into images or committed.

PostgREST is an internal component in this profile too. Bind it to the private
container network only, and access memory through OpenCortex services rather
than exposing PostgREST directly to the browser or host network.
