//! The clock: tokio's hierarchical timer wheel (six levels of 64 slots, 1 ms
//! precision), reached without naming tokio above the seam.

use std::future::Future;
use std::time::Duration;

use crate::seam::Elapsed;

/// Wait for `duration`.
///
/// # Arguments
///
/// * `duration` - how long.
pub async fn sleep(duration: Duration) {
    tokio::time::sleep(duration).await;
}

/// Run `future` for at most `duration`.
///
/// # Arguments
///
/// * `duration` - the deadline, from now.
/// * `future` - the work.
///
/// # Returns
///
/// The future's output.
///
/// # Errors
///
/// [`Elapsed`] when the deadline passed first; the future is dropped.
pub async fn timeout<F>(duration: Duration, future: F) -> Result<F::Output, Elapsed>
where
    F: Future,
{
    tokio::time::timeout(duration, future)
        .await
        .map_err(|_| Elapsed)
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{sleep, timeout};
    use crate::seam::Elapsed;

    #[test]
    fn the_clock_sleeps_and_times_out() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap();
        runtime.block_on(async {
            let start = Instant::now();
            sleep(Duration::from_millis(15)).await;
            assert!(start.elapsed() >= Duration::from_millis(15));
            assert_eq!(timeout(Duration::from_secs(5), async { 3 }).await, Ok(3));
            assert_eq!(
                timeout(Duration::from_millis(10), sleep(Duration::from_secs(5))).await,
                Err(Elapsed)
            );
        });
    }
}
