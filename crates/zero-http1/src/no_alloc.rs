//! The allocation-free claim of the codec, held by the counting allocator: parsing a
//! head, decoding a chunked body with its trailers, and serializing a response make no
//! call to the global allocator once the caller's buffers and tables are in place.

use zero_http_types::{HeaderName, StatusCode};
use zero_limits::http1::Http1Limits;
use zero_sys::alloc::Counting;

use crate::{
    parse_request, parse_trailers, ChunkedDecoder, Field, ResponseWriter, Span, Status, Step,
    WriteError,
};

#[global_allocator]
static ALLOCATOR: Counting = Counting::new();

const REQUEST: &[u8] = b"POST /submit?draft=1 HTTP/1.1\r\n\
Host: example.org\r\n\
User-Agent: zero-http1 tests\r\n\
Accept: */*\r\n\
Transfer-Encoding: chunked\r\n\
Connection: keep-alive\r\n\
Expect: 100-continue\r\n\
\r\n";

const BODY: &[u8] = b"5;note=first\r\nhello\r\n6\r\n world\r\n0\r\n\
X-Checksum: 3a1f\r\n\
Content-Length: 11\r\n\
\r\n";

#[test]
fn the_head_parser_never_allocates() {
    let limits = Http1Limits::DEFAULT;
    let mut table = [Field::EMPTY; 16];

    let (status, allocations) = Counting::count(|| parse_request(REQUEST, &mut table, &limits));
    assert!(matches!(status, Status::Complete(_)), "{status:?}");
    assert_eq!(allocations, 0);

    let partial = REQUEST
        .get(..REQUEST.len().saturating_sub(1))
        .unwrap_or(&[]);
    let (status, allocations) = Counting::count(|| parse_request(partial, &mut table, &limits));
    assert_eq!(status, Status::Partial);
    assert_eq!(allocations, 0);

    let bad = b"GET / HTTP/1.1\r\nHost: a\r\nBad Name: x\r\n\r\n";
    let (status, allocations) = Counting::count(|| parse_request(bad, &mut table, &limits));
    assert!(matches!(status, Status::Reject(_)), "{status:?}");
    assert_eq!(allocations, 0);
}

#[test]
fn the_chunked_decoder_and_the_trailer_parser_never_allocate() {
    let limits = Http1Limits::DEFAULT;
    let mut decoder = ChunkedDecoder::new();
    let mut table = [Field::EMPTY; 8];

    let (outcome, allocations) = Counting::count(|| {
        let mut pos = 0usize;
        let mut data_len = 0usize;
        loop {
            let rest = BODY.get(pos..).unwrap_or(&[]);
            match decoder.decode(rest, &limits) {
                Ok(Step::Data { data, consumed }) => {
                    data_len = data_len.saturating_add(data.len());
                    pos = pos.saturating_add(consumed);
                }
                Ok(Step::Done { trailers, consumed }) => {
                    let section = Span::new(
                        trailers.start.saturating_add(pos),
                        trailers.end.saturating_add(pos),
                    );
                    let fields = parse_trailers(BODY, section, &mut table, &limits);
                    return Ok((data_len, pos.saturating_add(consumed), fields));
                }
                Ok(Step::NeedMore { consumed }) => return Err(consumed),
                Err(reject) => return Err(usize::from(reject.status.as_u16())),
            }
        }
    });
    assert_eq!(outcome, Ok((11, BODY.len(), Ok(1))));
    assert_eq!(allocations, 0);
}

#[test]
fn the_response_writer_never_allocates() {
    let mut out = [0u8; 512];

    let (written, allocations) = Counting::count(|| {
        let mut writer = ResponseWriter::new(&mut out, false);
        writer.status_line(StatusCode::OK)?;
        writer.field_id(HeaderName::ContentType, b"text/plain")?;
        writer.field(b"X-Trace", b"3a1f")?;
        writer.content_length(5)?;
        writer.end_head()?;
        writer.body(b"hello")?;
        Ok::<usize, WriteError>(writer.len())
    });
    assert!(written.is_ok_and(|len| len > 0), "{written:?}");
    assert_eq!(allocations, 0);

    let (written, allocations) = Counting::count(|| {
        let mut writer = ResponseWriter::new(&mut out, false);
        writer.status_line(StatusCode::OK)?;
        writer.chunked()?;
        writer.connection_close()?;
        writer.end_head()?;
        writer.chunk(b"hello")?;
        writer.chunk(b" world")?;
        writer.last_chunk()?;
        Ok::<usize, WriteError>(writer.len())
    });
    assert!(written.is_ok_and(|len| len > 0), "{written:?}");
    assert_eq!(allocations, 0);
}
