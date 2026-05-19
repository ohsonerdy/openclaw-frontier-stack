// napi-build emits the cargo metadata that napi-rs needs at compile time
// (linker flags for the Node.js extension ABI, dispatch table, etc.).
extern crate napi_build;

fn main() {
    napi_build::setup();
}
