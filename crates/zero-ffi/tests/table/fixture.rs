//! The live fixture: one real server started through the C ABI, with genuinely leased
//! slots held on the test thread, which polled them and so is bound to the target.
//!
//! Every auxiliary slot is leased on a connection of its own and its batch acknowledged
//! at once, so its views need a pin; the live slot is leased last and its batch stays
//! unacknowledged until `finish`, so the test thread reads its views inside the batch
//! window. The closed lease is leased on a second server and pinned before that server's
//! target is detached, which closes it: a peer that goes away does not cancel a lease,
//! and the pin keeps it closed rather than retired while the cases run.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Mutex;

use zero_core::SlotId;
use zero_ffi::*;

use crate::support::{
    address, app_new, attach, complete, eventually, last_error, ok, poll_batch, route, server_new,
    stop, upgrade_request, workers, Client, FOREIGN_WORKER,
};

/// The live server, its slots, and the ids derived from them.
pub struct Live {
    pub app: u64,
    pub server: u64,
    pub worker: u8,
    pub target: u64,
    pub address: SocketAddr,
    pub host_route: u32,
    pub ws_route: u32,
    /// The live slot, its batch unacknowledged.
    pub slot: u64,
    pub epoch: u64,
    pub respond: u64,
    pub send: u64,
    pub error: u64,
    pub file: u64,
    pub sse: u64,
    pub region: u64,
    pub other: u64,
    pub ws: u64,
    pub ws2: u64,
    /// A lease closed by its target's detach, pinned so it stays closed.
    pub closed: u64,
    closer: u64,
    closer_app: u64,
    closer_client: Client,
    /// A slot completed and retired.
    pub recycled: u64,
    /// The live slot's index at the next generation.
    pub stale: u64,
    /// A slot id of a worker index no server claimed.
    pub foreign: u64,
    /// 2^53, one above the largest id.
    pub wide: u64,
    pub ws_conn: u64,
    pub ws2_conn: u64,
    pub sse_conn: u64,
    pub conn_stale: u64,
    pub conn_foreign: u64,
    pub app_stale: u64,
    pub server_stale: u64,
    pub target_stale: u64,
    /// A directory with `hello.txt` for the file action.
    pub root: PathBuf,
    clients: Mutex<Vec<(&'static str, Client)>>,
}

/// The id with the next generation of the same worker and index.
fn next_generation(id: u64) -> u64 {
    let id = SlotId::from_raw(id).expect("an id");
    id.with_generation(zero_core::slot::next_generation(id.generation()))
        .expect("a generation")
        .as_u64()
}

/// The request of an auxiliary slot.
fn get(name: &str) -> Vec<u8> {
    format!("GET /t/{name} HTTP/1.1\r\nHost: t\r\nX-Case: {name}\r\n\r\n").into_bytes()
}

impl Live {
    /// Start the server and lease every slot.
    pub fn start() -> Live {
        let app = app_new();
        let host_route = route(app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/t/:p", "");
        let ws_route = route(
            app,
            ZERO_ROUTE_WEBSOCKET,
            ZERO_METHOD_GET,
            "/ws",
            r#"{"protocols":["chat"]}"#,
        );
        let server = server_new(
            app,
            r#"{"threads":1,"maxBatchesInFlight":8,"drainMs":5000}"#,
        );
        let worker = workers(server)[0];
        let target = attach(server, u32::from(worker));
        ok(zero_server_start(server));
        let address = address(server);
        let mut clients = Vec::new();
        let mut lease = |name: &'static str, request: Vec<u8>, acknowledge: bool| -> (u64, u64) {
            let mut client = Client::connect(address);
            client.send(&request);
            let polled = poll_batch(target);
            assert_eq!(polled.slots.len(), 1, "one request per batch");
            if acknowledge {
                ok(complete(worker, &[], polled.batch.epoch).0);
            }
            clients.push((name, client));
            (polled.slots[0], polled.batch.epoch)
        };

        let (recycled, _) = lease("recycled", get("recycled"), true);
        let (respond, _) = lease("respond", get("respond"), true);
        let (send, _) = lease("send", get("send"), true);
        let (error, _) = lease("error", get("error"), true);
        let (file, _) = lease("file", get("file"), true);
        let (sse, _) = lease("sse", get("sse"), true);
        let (region, _) = lease("region", get("region"), true);
        let (other, _) = lease("other", get("other"), true);
        let (ws, _) = lease("ws", upgrade_request("/ws", Some("chat")), true);
        let (ws2, _) = lease("ws2", upgrade_request("/ws", None), true);
        let live_request =
            b"GET /t/live?q=1 HTTP/1.1\r\nHost: t\r\nX-Case: live\r\nX-Dup: a\r\nX-Dup: b\r\n\r\n";
        let (slot, epoch) = lease("live", live_request.to_vec(), false);

        ok(zero_res_send(recycled));
        assert_eq!(complete(worker, &[recycled], 0).0, ZeroStatus::Ok);
        let reply = take(&mut clients, "recycled")
            .read()
            .expect("the recycled reply");
        assert_eq!(reply.status, 200);
        eventually("the recycled slot to retire", || {
            let mut route = 0;
            // SAFETY: `route` is a writable `uint32_t`.
            let status = unsafe { zero_slot_route(recycled, &mut route) };
            status == ZeroStatus::Closed
        });

        let closer_app = app_new();
        route(closer_app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/c", "");
        let closer = server_new(closer_app, r#"{"threads":1}"#);
        let closer_worker = workers(closer)[0];
        let closer_target = attach(closer, u32::from(closer_worker));
        ok(zero_server_start(closer));
        let mut closer_client = Client::connect(crate::support::address(closer));
        closer_client.send(b"GET /c HTTP/1.1\r\nHost: t\r\n\r\n");
        let polled = poll_batch(closer_target);
        let closed = polled.slots[0];
        ok(complete(closer_worker, &[], polled.batch.epoch).0);
        ok(zero_slot_pin(closed));
        ok(zero_target_detach(closer_target));
        eventually("the detached target to close its lease", || {
            let mut canceled = 0;
            // SAFETY: `canceled` is a writable `uint8_t`.
            let status = unsafe { zero_slot_canceled(closed, &mut canceled) };
            status == ZeroStatus::Ok && canceled == 1
        });

        let mut ws_conn = 0;
        let protocol = b"chat";
        // SAFETY: the range is `protocol` and `ws_conn` is writable.
        ok(unsafe { zero_res_ws_accept(ws, protocol.as_ptr(), protocol.len(), &mut ws_conn) });
        let mut ws2_conn = 0;
        // SAFETY: an empty protocol and a writable `ws2_conn`.
        ok(unsafe { zero_res_ws_accept(ws2, std::ptr::null(), 0, &mut ws2_conn) });
        let mut sse_conn = 0;
        // SAFETY: `sse_conn` is a writable `uint64_t`.
        ok(unsafe { zero_res_sse_open(sse, 0, &mut sse_conn) });

        let app_stale = app_new();
        ok(zero_app_free(app_stale));
        let spare_app = app_new();
        route(spare_app, ZERO_ROUTE_HOST, ZERO_METHOD_GET, "/x", "");
        let server_stale = server_new(spare_app, r#"{"threads":1}"#);
        let target_stale = attach(server_stale, u32::from(workers(server_stale)[0]));
        ok(zero_target_detach(target_stale));
        ok(zero_server_free(server_stale));
        ok(zero_app_free(spare_app));

        let root =
            std::env::temp_dir().join(format!("zero-ffi-table-{}-{}", std::process::id(), worker));
        std::fs::create_dir_all(&root).expect("a root");
        std::fs::write(root.join("hello.txt"), b"hello").expect("a file");

        let foreign = SlotId::new(FOREIGN_WORKER, 1, 0).expect("an id").as_u64();
        Live {
            app,
            server,
            worker,
            target,
            address,
            host_route,
            ws_route,
            slot,
            epoch,
            respond,
            send,
            error,
            file,
            sse,
            region,
            other,
            ws,
            ws2,
            closed,
            closer,
            closer_app,
            closer_client,
            recycled,
            stale: next_generation(slot),
            foreign,
            wide: 1u64 << 53,
            ws_conn,
            ws2_conn,
            sse_conn,
            conn_stale: next_generation(ws_conn),
            conn_foreign: foreign,
            app_stale,
            server_stale,
            target_stale,
            root,
            clients: Mutex::new(clients),
        }
    }

    /// Take the client of one slot out of the fixture.
    pub fn client(&self, name: &str) -> Client {
        take(&mut self.clients.lock().unwrap(), name)
    }

    /// Answer the live slot, complete every slot and acknowledge the live batch, read the
    /// responses the cases left, and stop the server.
    pub fn finish(self) {
        ok(zero_slot_unpin(self.closed));
        let mut closer_client = self.closer_client;
        let refused = closer_client.read().expect("the closed lease's reply");
        assert_eq!(refused.status, 503);
        stop(self.closer);
        ok(zero_app_free(self.closer_app));
        ok(zero_res_reset(self.slot));
        ok(zero_res_status(self.slot, 200));
        let body = b"live";
        // SAFETY: the range is `body`.
        ok(unsafe { zero_res_body_copy(self.slot, body.as_ptr(), body.len()) });
        ok(zero_res_send(self.slot));
        let ids = [
            self.slot,
            self.respond,
            self.send,
            self.error,
            self.file,
            self.sse,
            self.region,
            self.ws,
            self.ws2,
        ];
        let (status, _) = complete(self.worker, &ids, self.epoch);
        assert_eq!(status, ZeroStatus::Ok, "{}", last_error());

        let mut clients = self.clients.into_inner().unwrap();
        let mut live = take(&mut clients, "live");
        let reply = live.read().expect("the live reply");
        assert_eq!((reply.status, reply.text().as_str()), (200, "live"));
        for (name, mut client) in clients {
            let reply = match name {
                "sse" | "ws" | "ws2" => client.read_head(),
                _ => client.read(),
            }
            .unwrap_or_else(|err| panic!("the {name} reply: {err}"));
            let expected = match name {
                "respond" => 201,
                "error" => 422,
                "ws" | "ws2" => 101,
                _ => 200,
            };
            assert_eq!(reply.status, expected, "the {name} reply");
            match name {
                "file" => assert_eq!(reply.text(), "hello"),
                "sse" => assert!(
                    reply
                        .header("content-type")
                        .is_some_and(|value| value.starts_with("text/event-stream")),
                    "{reply:?}"
                ),
                "region" => assert_eq!(reply.body, vec![0u8; 16]),
                "respond" => {
                    assert_eq!(reply.headers_named("set-cookie"), ["a=1", "b=2"]);
                    assert_eq!(reply.text(), "made");
                }
                _ => {}
            }
        }

        ok(zero_target_detach(self.target));
        stop(self.server);
        ok(zero_app_free(self.app));
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Take the client named `name` out of `clients`.
fn take(clients: &mut Vec<(&'static str, Client)>, name: &str) -> Client {
    let at = clients
        .iter()
        .position(|(held, _)| *held == name)
        .unwrap_or_else(|| panic!("no client {name}"));
    clients.remove(at).1
}
