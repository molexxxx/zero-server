//! Probe module: isolates the PyO3 costs that decide the handler model.

use std::time::Instant;

use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyTuple};

#[pyfunction]
fn noop() -> u32
{
    1
}

/// Borrowed view of a bytes object, no copy.
#[pyfunction]
fn sum_bytes(data: &[u8]) -> u32
{
    data.iter().map(|b| *b as u32).sum()
}

/// String argument: decoded into a Rust String (copy).
#[pyfunction]
fn take_str(s: &str) -> u32
{
    s.len() as u32
}

/// A request-like native object handed to Python as an opaque class instance.
#[pyclass]
struct Req
{
    method: u8,
    path: String,
    headers: Vec<(String, String)>,
}

#[pymethods]
impl Req
{
    #[getter]
    fn method(&self) -> u8
    {
        self.method
    }

    #[getter]
    fn path(&self) -> &str
    {
        &self.path
    }

    fn header(&self, name: &str) -> Option<&str>
    {
        self.headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
    }
}

#[pyfunction]
fn make_req() -> Req
{
    Req {
        method: 1,
        path: "/json".to_owned(),
        headers: vec![
            ("host".to_owned(), "localhost".to_owned()),
            ("accept".to_owned(), "*/*".to_owned()),
            ("user-agent".to_owned(), "wrk".to_owned()),
        ],
    }
}

/// A Rust-owned body handed to Python as bytes (one copy into the bytes object).
#[pyfunction]
fn make_body<'py>(py: Python<'py>, size: usize) -> Bound<'py, PyBytes>
{
    PyBytes::new(py, &vec![b'x'; size])
}

/// Rust calls a Python callable n times while attached on the calling thread.
#[pyfunction]
fn call_back_attached(py: Python<'_>, cb: Bound<'_, PyAny>, n: u32) -> PyResult<f64>
{
    let start = Instant::now();
    let mut sink = 0u32;
    for i in 0..n
    {
        sink = sink.wrapping_add(cb.call1((i,))?.extract::<u32>()?);
    }
    let _ = py;
    if sink == u32::MAX
    {
        return Err(pyo3::exceptions::PyRuntimeError::new_err("unreachable"));
    }
    Ok(start.elapsed().as_nanos() as f64 / n as f64)
}

/// The caller detaches; a foreign std thread attaches once and calls n times.
#[pyfunction]
fn call_back_thread_attach_once(py: Python<'_>, cb: Py<PyAny>, n: u32) -> PyResult<f64>
{
    py.detach(move || {
        let handle = std::thread::spawn(move || {
            Python::attach(|py| {
                let cb = cb.bind(py);
                let start = Instant::now();
                let mut sink = 0u32;
                for i in 0..n
                {
                    sink = sink.wrapping_add(cb.call1((i,)).unwrap().extract::<u32>().unwrap());
                }
                let _ = sink;
                start.elapsed().as_nanos() as f64 / n as f64
            })
        });
        Ok(handle.join().unwrap())
    })
}

/// The caller detaches; a foreign std thread attaches and detaches around every call
/// (the shape of "one interpreter attach per request" from an I/O worker).
#[pyfunction]
fn call_back_thread_attach_each(py: Python<'_>, cb: Py<PyAny>, n: u32) -> PyResult<f64>
{
    py.detach(move || {
        let handle = std::thread::spawn(move || {
            let start = Instant::now();
            let mut sink = 0u32;
            for i in 0..n
            {
                sink = sink.wrapping_add(Python::attach(|py| {
                    cb.bind(py).call1((i,)).unwrap().extract::<u32>().unwrap()
                }));
            }
            let _ = sink;
            start.elapsed().as_nanos() as f64 / n as f64
        });
        Ok(handle.join().unwrap())
    })
}

/// Batched: one call carries `batch` integers as a tuple; Python returns one number.
#[pyfunction]
fn call_back_batched(py: Python<'_>, cb: Bound<'_, PyAny>, n: u32, batch: u32) -> PyResult<f64>
{
    let rounds = n / batch;
    let start = Instant::now();
    for r in 0..rounds
    {
        let items = PyTuple::new(py, (0..batch).map(|i| r * batch + i))?;
        cb.call1((items,))?;
    }
    Ok(start.elapsed().as_nanos() as f64 / (rounds * batch) as f64)
}

#[pymodule]
fn pyo3_probe(m: &Bound<'_, PyModule>) -> PyResult<()>
{
    m.add_function(wrap_pyfunction!(noop, m)?)?;
    m.add_function(wrap_pyfunction!(sum_bytes, m)?)?;
    m.add_function(wrap_pyfunction!(take_str, m)?)?;
    m.add_function(wrap_pyfunction!(make_req, m)?)?;
    m.add_function(wrap_pyfunction!(make_body, m)?)?;
    m.add_function(wrap_pyfunction!(call_back_attached, m)?)?;
    m.add_function(wrap_pyfunction!(call_back_thread_attach_once, m)?)?;
    m.add_function(wrap_pyfunction!(call_back_thread_attach_each, m)?)?;
    m.add_function(wrap_pyfunction!(call_back_batched, m)?)?;
    m.add_class::<Req>()?;
    Ok(())
}
