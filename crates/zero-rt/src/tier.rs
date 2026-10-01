//! The five handler tiers of `DESIGN.md` section 7.2, ordered so that everything
//! expressible as data runs in Rust without a boundary crossing.

/// Where a route's work runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Tier {
    /// Declarative routes: static bodies, files, redirects, probes, proxy targets and
    /// rejections, built once by the bound language and served by Rust. No crossing.
    Declarative = 0,
    /// Cached handlers: hits served from the per-core cache shard, misses falling
    /// through to the batched tier.
    Cached = 1,
    /// Data routes: a query plan pipelined on the worker's connection and serialized
    /// straight into the response. No crossing.
    Data = 2,
    /// Batched bound-language handlers: ready requests are handed to the host target
    /// paired with the core, a batch at a time.
    Batched = 3,
    /// Rust handlers: `!Send` futures polled inline by the owning connection task.
    Local = 4,
}

impl Tier {
    /// Whether requests of this tier leave the worker for a host target.
    #[must_use]
    pub const fn crosses(self) -> bool {
        matches!(self, Self::Batched)
    }

    /// The tier with this number.
    ///
    /// # Arguments
    ///
    /// * `number` - 0 to 4.
    ///
    /// # Returns
    ///
    /// The tier, or `None` for another number.
    #[must_use]
    pub const fn from_number(number: u8) -> Option<Self> {
        match number {
            0 => Some(Self::Declarative),
            1 => Some(Self::Cached),
            2 => Some(Self::Data),
            3 => Some(Self::Batched),
            4 => Some(Self::Local),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Tier;

    #[test]
    fn only_the_batched_tier_crosses() {
        for number in 0..5 {
            let tier = Tier::from_number(number).unwrap();
            assert_eq!(tier as u8, number);
            assert_eq!(tier.crosses(), tier == Tier::Batched);
        }
        assert_eq!(Tier::from_number(5), None);
    }
}
