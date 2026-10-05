#![cfg(windows)]

// Compile and run the production actor with real KNP sockets, without the
// desktop/libp2p session. The tests live next to the actor they exercise.
#[path = "../src/knp_chat.rs"]
mod knp_chat;
#[path = "../src/kononexus_transport.rs"]
mod kononexus_transport;
