//! The datagram batch trait over loopback: peers, destinations, truncation, and on
//! Linux the ECN codepoint and the segmentation and coalescing offloads.

#![cfg(any(feature = "io-tokio", feature = "io-compio"))]

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use zero_core::OwnedBuf;
use zero_io::rt::{DatagramConfig, UdpSocket};
use zero_io::seam::Datagram;
use zero_io::{DatagramMeta, Ecn};

fn bufs(count: usize, capacity: usize) -> Vec<OwnedBuf> {
    (0..count)
        .map(|_| OwnedBuf::with_capacity(capacity))
        .collect()
}

/// Receive until `expected` datagrams arrived, in batches.
async fn receive_all(
    socket: &UdpSocket,
    expected: usize,
    capacity: usize,
) -> Vec<(OwnedBuf, DatagramMeta)> {
    let mut out = Vec::new();
    while out.len() < expected {
        let mut incoming = bufs(4, capacity);
        let mut meta = vec![DatagramMeta::default(); 4];
        let count = zero_io::rt::timeout(
            std::time::Duration::from_secs(5),
            socket.recv_batch(&mut incoming, &mut meta),
        )
        .await
        .expect("datagrams arrive in time")
        .unwrap();
        assert!(count >= 1);
        for (buf, entry) in incoming.into_iter().zip(meta).take(count) {
            out.push((buf, entry));
        }
    }
    out
}

#[test]
fn a_batch_crosses_loopback_with_its_metadata() {
    zero_io::rt::block_on(async {
        let sender =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let receiver =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let to = receiver.local_addr().unwrap();
        let outgoing: Vec<OwnedBuf> = (0..3)
            .map(|index| OwnedBuf::from_vec(format!("datagram {index}").into_bytes()))
            .collect();
        let meta = vec![
            DatagramMeta {
                peer: Some(to),
                local: Some(IpAddr::V4(Ipv4Addr::LOCALHOST)),
                ..DatagramMeta::default()
            };
            3
        ];
        assert_eq!(sender.send_batch(&outgoing, &meta).await.unwrap(), 3);

        let received = receive_all(&receiver, 3, 64).await;
        let mut payloads: Vec<Vec<u8>> = received
            .iter()
            .map(|(buf, _)| buf.filled().to_vec())
            .collect();
        payloads.sort();
        assert_eq!(
            payloads,
            [
                b"datagram 0".to_vec(),
                b"datagram 1".to_vec(),
                b"datagram 2".to_vec()
            ]
        );
        for (_, entry) in &received {
            assert_eq!(entry.peer, Some(sender.local_addr().unwrap()));
            assert!(!entry.truncated);
            assert_eq!(entry.ecn, Ecn::NotCapable);
            #[cfg(any(target_os = "linux", target_vendor = "apple"))]
            assert_eq!(entry.local, Some(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        }
    })
    .unwrap();
}

#[test]
fn a_datagram_longer_than_the_buffer_is_marked_truncated() {
    zero_io::rt::block_on(async {
        let sender =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let receiver =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let meta = [DatagramMeta {
            peer: Some(receiver.local_addr().unwrap()),
            ..DatagramMeta::default()
        }];
        let outgoing = [OwnedBuf::from_vec(b"0123456789".to_vec())];
        assert_eq!(sender.send_batch(&outgoing, &meta).await.unwrap(), 1);
        let received = receive_all(&receiver, 1, 4).await;
        let (buf, entry) = &received[0];
        assert_eq!(buf.filled(), b"0123");
        #[cfg(unix)]
        assert!(entry.truncated);
        let _ = entry;
    })
    .unwrap();
}

#[test]
fn mismatched_metadata_is_refused_before_any_call() {
    zero_io::rt::block_on(async {
        let socket =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let mut incoming = bufs(2, 16);
        let mut meta = vec![DatagramMeta::default(); 1];
        let err = socket
            .recv_batch(&mut incoming, &mut meta)
            .await
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        let err = socket.send_batch(&incoming, &meta).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert_eq!(socket.recv_batch(&mut [], &mut []).await.unwrap(), 0);
        assert!(!socket.is_v6());
    })
    .unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn the_ecn_codepoint_travels_per_datagram() {
    zero_io::rt::block_on(async {
        let sender =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let receiver =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let to = receiver.local_addr().unwrap();
        let outgoing = [
            OwnedBuf::from_vec(b"ect0".to_vec()),
            OwnedBuf::from_vec(b"ce".to_vec()),
        ];
        let meta = [
            DatagramMeta {
                peer: Some(to),
                ecn: Ecn::Ect0,
                ..DatagramMeta::default()
            },
            DatagramMeta {
                peer: Some(to),
                ecn: Ecn::Ce,
                ..DatagramMeta::default()
            },
        ];
        assert_eq!(sender.send_batch(&outgoing, &meta).await.unwrap(), 2);
        let received = receive_all(&receiver, 2, 16).await;
        for (buf, entry) in &received {
            let expected = if buf.filled() == b"ect0" {
                Ecn::Ect0
            } else {
                Ecn::Ce
            };
            assert_eq!(entry.ecn, expected, "{:?}", buf.filled());
        }
    })
    .unwrap();
}

#[cfg(target_os = "linux")]
#[test]
fn segmentation_splits_a_buffer_and_coalescing_reports_the_size() {
    zero_io::rt::block_on(async {
        let sender =
            UdpSocket::bind("127.0.0.1:0".parse().unwrap(), &DatagramConfig::default()).unwrap();
        let receiver = UdpSocket::bind(
            "127.0.0.1:0".parse().unwrap(),
            &DatagramConfig {
                gro: true,
                ..DatagramConfig::default()
            },
        )
        .unwrap();
        let outgoing = [OwnedBuf::from_vec(vec![b'x'; 1800])];
        let meta = [DatagramMeta {
            peer: Some(receiver.local_addr().unwrap()),
            segment_size: Some(600),
            ..DatagramMeta::default()
        }];
        assert_eq!(sender.send_batch(&outgoing, &meta).await.unwrap(), 1);
        let mut total = 0;
        let mut received = Vec::new();
        while total < 1800 {
            let batch = receive_all(&receiver, 1, 2048).await;
            for (buf, entry) in batch {
                total += buf.len();
                received.push((buf, entry));
            }
        }
        assert_eq!(total, 1800, "every segment arrives");
        for (buf, entry) in &received {
            assert!(
                buf.len() == 600 || entry.segment_size == Some(600),
                "{} bytes with {:?}",
                buf.len(),
                entry.segment_size
            );
        }
    })
    .unwrap();
}

#[test]
fn ipv6_loopback_carries_the_destination_when_available() {
    let Ok(sender) = std::net::UdpSocket::bind("[::1]:0") else {
        return;
    };
    drop(sender);
    zero_io::rt::block_on(async {
        let v6: SocketAddr = "[::1]:0".parse().unwrap();
        let sender = UdpSocket::bind(v6, &DatagramConfig::default()).unwrap();
        let receiver = UdpSocket::bind(v6, &DatagramConfig::default()).unwrap();
        assert!(sender.is_v6());
        let meta = [DatagramMeta {
            peer: Some(receiver.local_addr().unwrap()),
            ..DatagramMeta::default()
        }];
        let outgoing = [OwnedBuf::from_vec(b"six".to_vec())];
        assert_eq!(sender.send_batch(&outgoing, &meta).await.unwrap(), 1);
        let received = receive_all(&receiver, 1, 16).await;
        let (buf, entry) = &received[0];
        assert_eq!(buf.filled(), b"six");
        assert_eq!(entry.peer, Some(sender.local_addr().unwrap()));
        #[cfg(any(target_os = "linux", target_vendor = "apple"))]
        assert_eq!(entry.local, Some(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)));
    })
    .unwrap();
}
