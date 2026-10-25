//! The pointer helpers: the only code that reads or writes memory a host passed.
//!
//! Each helper checks what it can about a pointer (NULL, alignment for an output or an
//! integer array, a length against `PTRDIFF_MAX`, a struct's size against its version 1
//! size) and then performs one operation: a slice over a byte or integer range, or a
//! byte copy into a zero-filled local or out to the host. A byte copy needs no
//! alignment, so a strided array is read and written whatever its stride, and an
//! element or a struct larger than the library's is read and written as its prefix.

use std::mem::size_of;
use std::ptr;
use std::slice;

use crate::guard::Fail;

/// The longest range in octets: `PTRDIFF_MAX`, the bound of every allocation.
pub(crate) const PTRDIFF_MAX: usize = isize::MAX.unsigned_abs();

/// A type whose fields are integers and raw pointers only, so its all-zero value and
/// every bit pattern a host writes are valid values: what a read starts from and may
/// fill with host bytes.
pub(crate) trait Zeroed: Copy {
    /// The all-zero value.
    const ZERO: Self;
}

impl Zeroed for u32 {
    const ZERO: Self = 0;
}

impl Zeroed for u64 {
    const ZERO: Self = 0;
}

/// A struct passed alone by pointer, which starts with `uint32_t size`.
pub(crate) trait Prefixed: Copy {
    /// The size of the struct at version 1 of the ABI; a smaller `size` is refused.
    const V1_SIZE: usize;

    /// The struct with its `size` field set to `size`.
    fn with_size(self, size: u32) -> Self;
}

const NULL_RANGE: Fail = Fail::invalid("a byte range is NULL with a nonzero length");
const LONG_RANGE: Fail = Fail::invalid("a range is longer than PTRDIFF_MAX octets");
const NULL_ARRAY: Fail = Fail::invalid("an array is NULL with a nonzero count");
const MISALIGNED_ARRAY: Fail = Fail::invalid("an array is not aligned for its element type");
const NULL_POINTER: Fail = Fail::invalid("a pointer argument is NULL");
const NULL_OUTPUT: Fail = Fail::invalid("an output pointer is NULL");
const MISALIGNED_OUTPUT: Fail = Fail::invalid("an output pointer is not aligned for its type");
const SMALL_STRUCT: Fail = Fail::invalid("a struct's size is below its version 1 size");

/// Check an output pointer before the call does anything, so a refused output leaves
/// every effect undone.
///
/// # Arguments
///
/// * `out` - the output.
///
/// # Errors
///
/// `InvalidArgument` for NULL or a pointer not aligned for `T`.
pub(crate) fn check_out<T>(out: *mut T) -> Result<(), Fail> {
    if out.is_null() {
        Err(NULL_OUTPUT)
    } else if !out.is_aligned() {
        Err(MISALIGNED_OUTPUT)
    } else {
        Ok(())
    }
}

/// Borrow a host byte range for the call.
///
/// # Arguments
///
/// * `ptr` - the first byte; any value, NULL included, when `len` is 0.
/// * `len` - the number of bytes.
///
/// # Returns
///
/// The bytes; empty for a zero length.
///
/// # Errors
///
/// `InvalidArgument` for NULL with a nonzero length or a length above `PTRDIFF_MAX`.
///
/// # Safety
///
/// When `len` is nonzero and `ptr` is not NULL, `ptr` must point to `len` initialized
/// bytes that stay valid and unchanged for `'a`, which never outlives the call.
#[allow(unsafe_code)]
pub(crate) unsafe fn read_bytes<'a>(ptr: *const u8, len: usize) -> Result<&'a [u8], Fail> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(NULL_RANGE);
    }
    if len > PTRDIFF_MAX {
        return Err(LONG_RANGE);
    }
    // SAFETY: `ptr` is not NULL and `len` is at most PTRDIFF_MAX; the caller guarantees
    // `len` initialized bytes at `ptr` that do not change while `'a` lasts.
    Ok(unsafe { slice::from_raw_parts(ptr, len) })
}

/// Borrow a host array of integers for the call.
///
/// # Arguments
///
/// * `ptr` - the first element; any value, NULL included, when `len` is 0.
/// * `len` - the number of elements.
///
/// # Returns
///
/// The elements; empty for a zero count.
///
/// # Errors
///
/// `InvalidArgument` for NULL with a nonzero count, a pointer not aligned for `T`, or
/// an array longer than `PTRDIFF_MAX` octets.
///
/// # Safety
///
/// When `len` is nonzero and `ptr` is not NULL, `ptr` must point to `len` initialized
/// values of `T`, an integer type, that stay valid and unchanged for `'a`, which never
/// outlives the call.
#[allow(unsafe_code)]
pub(crate) unsafe fn read_slice<'a, T: Zeroed>(ptr: *const T, len: usize) -> Result<&'a [T], Fail> {
    if len == 0 {
        return Ok(&[]);
    }
    if ptr.is_null() {
        return Err(NULL_ARRAY);
    }
    if !ptr.is_aligned() {
        return Err(MISALIGNED_ARRAY);
    }
    if len
        .checked_mul(size_of::<T>())
        .is_none_or(|bytes| bytes > PTRDIFF_MAX)
    {
        return Err(LONG_RANGE);
    }
    // SAFETY: `ptr` is not NULL, is aligned for `T`, and the array is at most
    // PTRDIFF_MAX octets; the caller guarantees `len` initialized values at `ptr` that do
    // not change while `'a` lasts, and every bit pattern is a valid `T`.
    Ok(unsafe { slice::from_raw_parts(ptr, len) })
}

/// Read element `index` of a strided host array into a zero-filled local: the smaller
/// of `stride` and the library's size of `T` is copied, so an element the host built
/// smaller reads with zeros after its end, and a larger one as its prefix.
///
/// # Arguments
///
/// * `base` - the first element.
/// * `index` - the element to read.
/// * `stride` - the distance between two elements in octets, the element size the host
///   built them with.
///
/// # Returns
///
/// The element.
///
/// # Errors
///
/// `InvalidArgument` for a NULL `base`, or an element that ends past `PTRDIFF_MAX`
/// octets from `base`.
///
/// # Safety
///
/// `base` must point to an array of at least `index + 1` elements, each `stride`
/// readable octets, that does not change during the call.
#[allow(unsafe_code)]
pub(crate) unsafe fn read_element<T: Zeroed>(
    base: *const T,
    index: usize,
    stride: usize,
) -> Result<T, Fail> {
    if base.is_null() {
        return Err(NULL_POINTER);
    }
    let Some(offset) = index.checked_mul(stride).filter(|offset| {
        offset
            .checked_add(stride)
            .is_some_and(|end| end <= PTRDIFF_MAX)
    }) else {
        return Err(LONG_RANGE);
    };
    let count = stride.min(size_of::<T>());
    let mut value = T::ZERO;
    let source = base.cast::<u8>().wrapping_add(offset);
    // SAFETY: `source` is element `index` of the caller's array, inside the PTRDIFF_MAX
    // bound, with at least `stride` readable octets, and `count` is at most `stride` and
    // the size of `value`, a local the copy cannot overlap; any bytes are a valid `T`.
    unsafe { ptr::copy_nonoverlapping(source, ptr::from_mut(&mut value).cast::<u8>(), count) };
    Ok(value)
}

/// Write `values` to a strided host array: element `i` goes `i * stride` octets after
/// `base`, as the smaller of `stride` and the library's size of `T` in octets, so an
/// element the host built larger keeps its octets past the library's, and a single
/// output is written with its own size as the stride.
///
/// # Arguments
///
/// * `base` - the first element of the output.
/// * `stride` - the distance between two elements in octets.
/// * `values` - what to write, one element each.
///
/// # Errors
///
/// `InvalidArgument` for a NULL `base`, a `base` not aligned for `T`, or an array longer
/// than `PTRDIFF_MAX` octets; nothing is written then.
///
/// # Safety
///
/// `base` must point to writable memory of at least `values.len()` elements of
/// `stride` octets each that nothing else accesses during the call, and `T` must have
/// no padding bytes.
#[allow(unsafe_code)]
pub(crate) unsafe fn write_elements<T: Copy>(
    base: *mut T,
    stride: usize,
    values: &[T],
) -> Result<(), Fail> {
    check_out(base)?;
    if values
        .len()
        .checked_mul(stride)
        .is_none_or(|bytes| bytes > PTRDIFF_MAX)
    {
        return Err(LONG_RANGE);
    }
    let count = stride.min(size_of::<T>());
    for (index, value) in values.iter().enumerate() {
        let target = base.cast::<u8>().wrapping_add(index.saturating_mul(stride));
        // SAFETY: `target` is element `index` of the caller's array, inside its writable
        // `values.len() * stride` octets, and `count` is at most `stride` and the size of
        // `value`, a value of the library's that the host memory cannot overlap.
        unsafe { ptr::copy_nonoverlapping(ptr::from_ref(value).cast::<u8>(), target, count) };
    }
    Ok(())
}

/// Read a struct the host passed alone by pointer, whose first field is its
/// `uint32_t size`: the size is read first, then the smaller of it and the library's
/// size, with zeros after a smaller struct's end.
///
/// # Arguments
///
/// * `ptr` - the struct.
///
/// # Returns
///
/// The struct.
///
/// # Errors
///
/// `InvalidArgument` for NULL or a `size` below the version 1 size.
///
/// # Safety
///
/// `ptr` must be NULL or point to a struct of at least `size` readable octets, as its
/// own `size` field states, that does not change during the call.
#[allow(unsafe_code)]
pub(crate) unsafe fn read_sized<T: Prefixed + Zeroed>(ptr: *const T) -> Result<T, Fail> {
    // SAFETY: a struct passed alone by pointer starts with its four-octet size, which
    // the caller guarantees is readable when `ptr` is not NULL; NULL is refused.
    let size = unsafe { read_element::<u32>(ptr.cast::<u32>(), 0, size_of::<u32>()) }?;
    let size = usize::try_from(size).unwrap_or(usize::MAX);
    if size < T::V1_SIZE {
        return Err(SMALL_STRUCT);
    }
    // SAFETY: the struct is `size` readable octets long, as its size field states, and
    // the read copies no more than that.
    unsafe { read_element::<T>(ptr, 0, size) }
}

/// Check a struct output whose first field is its `uint32_t size`, which the host set
/// before the call, before the call does anything.
///
/// # Arguments
///
/// * `out` - the output struct.
///
/// # Returns
///
/// How many octets the library writes: the smaller of `size` and its own size.
///
/// # Errors
///
/// `InvalidArgument` for NULL, a pointer not aligned for `T`, or a `size` below the
/// version 1 size.
///
/// # Safety
///
/// `out` must be NULL or point to a struct of at least `size` writable octets, as its
/// own `size` field states, whose size field is initialized.
#[allow(unsafe_code)]
pub(crate) unsafe fn out_size<T: Prefixed>(out: *mut T) -> Result<usize, Fail> {
    check_out(out)?;
    // SAFETY: `out` is not NULL and is aligned, and the caller guarantees the size field
    // at its start is initialized.
    let size = unsafe { read_element::<u32>(out.cast_const().cast::<u32>(), 0, size_of::<u32>()) }?;
    let size = usize::try_from(size).unwrap_or(usize::MAX);
    if size < T::V1_SIZE {
        return Err(SMALL_STRUCT);
    }
    Ok(size.min(size_of::<T>()))
}

/// Write a struct output whose first field is its `uint32_t size`: the first `written`
/// octets of `value`, with `size` set to `written`.
///
/// # Arguments
///
/// * `out` - the output struct.
/// * `written` - what [`out_size`] returned for `out`.
/// * `value` - the struct to write.
///
/// # Errors
///
/// `InvalidArgument` for NULL or a pointer not aligned for `T`; nothing is written then.
///
/// # Safety
///
/// As [`out_size`], with `written` the value it returned for this `out`, and `T` must
/// have no padding bytes.
#[allow(unsafe_code)]
pub(crate) unsafe fn write_sized<T: Prefixed>(
    out: *mut T,
    written: usize,
    value: T,
) -> Result<(), Fail> {
    let value = value.with_size(u32::try_from(written).unwrap_or(u32::MAX));
    // SAFETY: `written` is at most the struct's own `size` and the library's size of `T`,
    // so the copy stays inside the writable struct the caller guarantees.
    unsafe { write_elements(out, written, slice::from_ref(&value)) }
}

#[cfg(test)]
#[allow(unsafe_code)]
mod tests {
    use std::mem::size_of;
    use std::ptr;

    use super::{
        check_out, out_size, read_bytes, read_element, read_sized, read_slice, write_elements,
        write_sized, Prefixed, Zeroed, PTRDIFF_MAX,
    };
    use crate::abi::{ZeroBatch, ZeroBytes, ZeroHeaderPair, ZeroStatus};

    fn status<T>(result: Result<T, crate::guard::Fail>) -> ZeroStatus {
        result.map_or_else(|fail| fail.status(), |_| ZeroStatus::Ok)
    }

    #[test]
    fn a_zero_length_range_accepts_any_pointer_and_null_with_a_length_is_refused() {
        // SAFETY: a zero length reads nothing.
        assert_eq!(unsafe { read_bytes(ptr::null(), 0) }.unwrap(), b"");
        let bytes = *b"abc";
        // SAFETY: `bytes` holds three bytes.
        assert_eq!(unsafe { read_bytes(bytes.as_ptr(), 3) }.unwrap(), b"abc");
        // SAFETY: NULL is refused before any read.
        let null = unsafe { read_bytes(ptr::null(), 1) };
        assert_eq!(status(null), ZeroStatus::InvalidArgument);
        // SAFETY: the length is refused before any read.
        let long = unsafe { read_bytes(bytes.as_ptr(), PTRDIFF_MAX + 1) };
        assert_eq!(status(long), ZeroStatus::InvalidArgument);
    }

    #[test]
    fn an_integer_array_must_be_aligned_and_not_null() {
        let ids = [7u64, 8, 9];
        // SAFETY: `ids` holds three elements.
        assert_eq!(unsafe { read_slice(ids.as_ptr(), 3) }.unwrap(), &[7, 8, 9]);
        // SAFETY: a zero count reads nothing.
        assert!(unsafe { read_slice::<u64>(ptr::null(), 0) }
            .unwrap()
            .is_empty());
        // SAFETY: NULL is refused before any read.
        let null = unsafe { read_slice::<u64>(ptr::null(), 2) };
        assert_eq!(status(null), ZeroStatus::InvalidArgument);
        let misaligned = ids.as_ptr().cast::<u8>().wrapping_add(1).cast::<u64>();
        // SAFETY: the misaligned pointer is refused before any read.
        let refused = unsafe { read_slice(misaligned, 1) };
        assert_eq!(status(refused), ZeroStatus::InvalidArgument);
        // SAFETY: the length is refused before any read.
        let long = unsafe { read_slice(ids.as_ptr(), PTRDIFF_MAX / 8 + 1) };
        assert_eq!(status(long), ZeroStatus::InvalidArgument);
    }

    #[test]
    fn an_element_reads_as_its_prefix_with_zeros_after_a_smaller_one() {
        let name = *b"name";
        let pairs = [
            ZeroHeaderPair {
                name: ZeroBytes::of(&name),
                value: ZeroBytes::of(&name[..2]),
            },
            ZeroHeaderPair {
                name: ZeroBytes::of(&name[1..]),
                value: ZeroBytes::of(&name[3..]),
            },
        ];
        let stride = size_of::<ZeroHeaderPair>();
        // SAFETY: `pairs` holds two elements of `stride` octets.
        let second = unsafe { read_element(pairs.as_ptr(), 1, stride) }.unwrap();
        assert_eq!(second, pairs[1]);
        // SAFETY: the first element is at least half a pair long.
        let half = unsafe { read_element(pairs.as_ptr(), 0, stride / 2) }.unwrap();
        assert_eq!(half.name, pairs[0].name);
        assert_eq!(half.value, ZeroBytes::ABSENT);
        // SAFETY: NULL is refused before any read.
        let null = unsafe { read_element::<u64>(ptr::null(), 0, 8) };
        assert_eq!(status(null), ZeroStatus::InvalidArgument);
        // SAFETY: the offset is refused before any read.
        let far = unsafe { read_element(pairs.as_ptr(), usize::MAX, stride) };
        assert_eq!(status(far), ZeroStatus::InvalidArgument);
    }

    #[test]
    fn elements_are_written_at_their_stride_and_leave_the_octets_past_them() {
        #[repr(C, align(8))]
        struct Aligned([u8; 24]);
        let mut aligned = Aligned([0xAA; 24]);
        let out = &mut aligned.0;
        let values = [0x0102_0304u32, 0x0506_0708];
        // SAFETY: `out` holds two strides of 12 octets, aligned for `u32`, and a `u32` has
        // no padding.
        unsafe { write_elements(out.as_mut_ptr().cast::<u32>(), 12, &values) }.unwrap();
        assert_eq!(out[..4], 0x0102_0304u32.to_ne_bytes());
        assert_eq!(out[4..12], [0xAA; 8]);
        assert_eq!(out[12..16], 0x0506_0708u32.to_ne_bytes());
        assert_eq!(out[16..], [0xAA; 8]);
        let misaligned = out.as_mut_ptr().wrapping_add(1).cast::<u32>();
        // SAFETY: the misaligned pointer is refused before any write.
        let refused = unsafe { write_elements(misaligned, 4, &values) };
        assert_eq!(status(refused), ZeroStatus::InvalidArgument);
        assert_eq!(out[16..], [0xAA; 8]);
        // SAFETY: NULL is refused before any write.
        let null = unsafe { write_elements(ptr::null_mut::<u32>(), 4, &values) };
        assert_eq!(status(null), ZeroStatus::InvalidArgument);
        assert_eq!(
            status(check_out(ptr::null_mut::<u64>())),
            ZeroStatus::InvalidArgument
        );
    }

    #[test]
    fn a_sized_struct_below_its_version_1_size_is_refused_and_a_larger_one_reads_as_its_prefix() {
        #[repr(C)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        struct Wider {
            batch: ZeroBatch,
            extra: u64,
        }
        let batch = ZeroBatch {
            size: u32::try_from(size_of::<Wider>()).unwrap(),
            worker: 3,
            kind: 1,
            flags: 0,
            count: 9,
            reserved: 0,
            epoch: 11,
        };
        let wider = Wider {
            batch,
            extra: u64::MAX,
        };
        // SAFETY: `wider` is `size` octets long.
        let read = unsafe { read_sized(ptr::from_ref(&wider).cast::<ZeroBatch>()) }.unwrap();
        assert_eq!(read, batch);
        let small = ZeroBatch {
            size: u32::try_from(ZeroBatch::V1_SIZE - 1).unwrap(),
            ..batch
        };
        // SAFETY: `small` is a whole struct whatever its size field says.
        let refused = unsafe { read_sized(ptr::from_ref(&small)) };
        assert_eq!(status(refused), ZeroStatus::InvalidArgument);
        // SAFETY: NULL is refused before any read.
        let null = unsafe { read_sized::<ZeroBatch>(ptr::null()) };
        assert_eq!(status(null), ZeroStatus::InvalidArgument);
    }

    #[test]
    fn a_sized_output_takes_the_smaller_size_and_stores_what_was_written() {
        let value = ZeroBatch {
            size: 0,
            worker: 1,
            kind: 2,
            flags: 0,
            count: 3,
            reserved: 0,
            epoch: 4,
        };
        #[repr(C)]
        struct Wider {
            batch: ZeroBatch,
            extra: u64,
        }
        let mut wide = Wider {
            batch: ZeroBatch {
                size: u32::try_from(size_of::<Wider>()).unwrap(),
                ..ZeroBatch::ZERO
            },
            extra: u64::MAX,
        };
        let out = ptr::from_mut(&mut wide).cast::<ZeroBatch>();
        // SAFETY: `wide` is `size` writable octets with an initialized size field.
        let written = unsafe { out_size(out) }.unwrap();
        assert_eq!(written, size_of::<ZeroBatch>());
        // SAFETY: as above, with the size `out_size` returned.
        unsafe { write_sized(out, written, value) }.unwrap();
        assert_eq!(
            wide.batch,
            ZeroBatch {
                size: u32::try_from(written).unwrap(),
                ..value
            }
        );
        assert_eq!(wide.extra, u64::MAX);
        let mut small = ZeroBatch::ZERO;
        small.size = 4;
        // SAFETY: `small` is a whole struct whatever its size field says.
        let refused = unsafe { out_size(ptr::from_mut(&mut small)) };
        assert_eq!(status(refused), ZeroStatus::InvalidArgument);
        assert_eq!(small.size, 4);
    }

    impl Zeroed for ZeroBatch {
        const ZERO: Self = ZeroBatch {
            size: 0,
            worker: 0,
            kind: 0,
            flags: 0,
            count: 0,
            reserved: 0,
            epoch: 0,
        };
    }
}
