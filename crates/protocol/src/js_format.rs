use crate::js_number::{json_number, shortest_digits};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("RangeError: toFixed() digits argument must be between 0 and 100")]
pub struct ToFixedError;

pub fn to_fixed(value: f64, fraction_digits: f64) -> Result<String, ToFixedError> {
    let digits = fraction_count(fraction_digits)?;
    if value.is_nan() {
        return Ok("NaN".to_string());
    }
    if value.is_infinite() {
        return Ok(if value.is_sign_negative() {
            "-Infinity".to_string()
        } else {
            "Infinity".to_string()
        });
    }
    let negative = value.is_sign_negative() && value != 0.0;
    let magnitude = value.abs();
    if magnitude >= 1e21 {
        return Ok(json_number(if negative { -magnitude } else { magnitude }));
    }
    let rounded = fixed_integer(magnitude, digits);
    Ok(format_fixed(negative, &rounded, digits))
}

pub fn number_to_locale_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value.is_sign_negative() {
            "-∞".to_string()
        } else {
            "∞".to_string()
        };
    }
    if value == 0.0 {
        return if value.is_sign_negative() {
            "-0".to_string()
        } else {
            "0".to_string()
        };
    }
    let negative = value.is_sign_negative();
    let body = locale_from_shortest(value.abs());
    let grouped = group_fixed(&body);
    if negative {
        format!("-{grouped}")
    } else {
        grouped
    }
}

pub fn number_to_locale_string_en_us(value: f64) -> String {
    number_to_locale_string(value)
}

pub fn number_to_locale_string_en(value: f64) -> String {
    number_to_locale_string(value)
}

pub fn intl_number_format(value: f64) -> String {
    number_to_locale_string(value)
}

fn locale_from_shortest(magnitude: f64) -> String {
    let (digits, exp_last) = shortest_digits(magnitude);
    if digits == "0" {
        return "0".to_string();
    }
    let len = i32::try_from(digits.len()).unwrap_or(i32::MAX);
    let exp_first = exp_last + len - 1;
    let keep = exp_first + 4;
    if keep < 0 {
        return "0".to_string();
    }
    let bytes = digits.as_bytes();
    if keep == 0 {
        let round_digit = bytes.first().copied().unwrap_or(b'0');
        if round_digit >= b'5' {
            return "0.001".to_string();
        }
        return "0".to_string();
    }
    let keep_len = usize::try_from(keep).unwrap_or(bytes.len());
    let mut kept = Vec::<u8>::new();
    let mut round_up = false;
    if bytes.len() > keep_len {
        round_up = bytes[keep_len] >= b'5';
        kept.extend_from_slice(&bytes[..keep_len]);
    } else {
        kept.extend_from_slice(bytes);
        kept.resize(keep_len, b'0');
    }
    if round_up {
        let mut index = kept.len();
        let mut carry = true;
        while carry && index > 0 {
            index -= 1;
            if kept[index] < b'9' {
                kept[index] += 1;
                carry = false;
            } else {
                kept[index] = b'0';
            }
        }
        if carry {
            kept.insert(0, b'1');
        }
    }
    let grew = kept.len() == keep_len + 1;
    let exp_now = if grew { exp_first + 1 } else { exp_first };
    let int_digits = exp_now + 1;
    if int_digits <= 0 {
        let mut out = String::from("0.");
        let zeros = usize::try_from(-int_digits).unwrap_or(0);
        for _ in 0..zeros {
            out.push('0');
        }
        for byte in kept {
            out.push(char::from(byte));
        }
        return out;
    }
    let int_len = usize::try_from(int_digits).unwrap_or(0);
    let mut out = String::new();
    for byte in kept.iter().take(int_len) {
        out.push(char::from(*byte));
    }
    if kept.len() > int_len {
        out.push('.');
        for byte in kept.iter().skip(int_len) {
            out.push(char::from(*byte));
        }
    }
    out
}

fn fraction_count(value: f64) -> Result<u32, ToFixedError> {
    if value.is_nan() {
        return Ok(0);
    }
    if !value.is_finite() {
        return Err(ToFixedError);
    }
    let truncated = value.trunc();
    if !(0.0..=100.0).contains(&truncated) {
        return Err(ToFixedError);
    }
    Ok(truncated as u32)
}

fn group_fixed(body: &str) -> String {
    let (integer, fraction) = match body.split_once('.') {
        Some((integer, fraction)) => (integer, fraction.trim_end_matches('0')),
        None => (body, ""),
    };
    let grouped = group_digits(integer);
    if fraction.is_empty() {
        grouped
    } else {
        format!("{grouped}.{fraction}")
    }
}

fn group_digits(digits: &str) -> String {
    let bytes = digits.as_bytes();
    let mut out = String::new();
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 && (bytes.len() - index).is_multiple_of(3) {
            out.push(',');
        }
        out.push(char::from(*byte));
    }
    out
}

fn fixed_integer(value: f64, digits: u32) -> UInt {
    if value == 0.0 {
        return UInt::zero();
    }
    let (significand, exponent) = decompose(value);
    let mut number = UInt::from_u64(significand);
    number.mul_pow5(digits);
    let shift = exponent + i32::try_from(digits).unwrap_or(0);
    if shift >= 0 {
        number.shl(shift as u32);
        number
    } else {
        number.round_away((-shift) as u32)
    }
}

fn decompose(value: f64) -> (u64, i32) {
    let bits = value.to_bits();
    let biased = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    if biased == 0 {
        (fraction, -1022 - 52)
    } else {
        (fraction | (1_u64 << 52), biased - 1023 - 52)
    }
}

fn format_fixed(negative: bool, number: &UInt, digits: u32) -> String {
    let mut body = number.to_decimal();
    if digits != 0 {
        let width = digits as usize;
        if body.len() <= width {
            let pad = width + 1 - body.len();
            let mut padded = "0".repeat(pad);
            padded.push_str(&body);
            body = padded;
        }
        let split = body.len() - width;
        body = format!("{}.{}", &body[..split], &body[split..]);
    }
    if negative {
        let mut signed = String::with_capacity(body.len() + 1);
        signed.push('-');
        signed.push_str(&body);
        signed
    } else {
        body
    }
}

#[derive(Clone)]
struct UInt {
    limbs: Vec<u64>,
}

impl UInt {
    fn zero() -> Self {
        Self { limbs: Vec::new() }
    }

    fn from_u64(value: u64) -> Self {
        if value == 0 {
            Self::zero()
        } else {
            Self { limbs: vec![value] }
        }
    }

    fn normalize(&mut self) {
        while self.limbs.last().is_some_and(|limb| *limb == 0) {
            self.limbs.pop();
        }
    }

    fn mul_u64(&mut self, factor: u64) {
        if factor == 0 || self.limbs.is_empty() {
            self.limbs.clear();
            return;
        }
        let mut carry = 0_u128;
        for limb in &mut self.limbs {
            let product = u128::from(*limb) * u128::from(factor) + carry;
            *limb = product as u64;
            carry = product >> 64;
        }
        if carry != 0 {
            self.limbs.push(carry as u64);
        }
    }

    fn mul_pow5(&mut self, digits: u32) {
        for _ in 0..digits {
            self.mul_u64(5);
        }
    }

    fn add_u64(&mut self, mut add: u64) {
        if add == 0 {
            return;
        }
        let mut index = 0;
        while add != 0 {
            if index == self.limbs.len() {
                self.limbs.push(add);
                return;
            }
            let sum = u128::from(self.limbs[index]) + u128::from(add);
            self.limbs[index] = sum as u64;
            add = (sum >> 64) as u64;
            index += 1;
        }
    }

    fn shl(&mut self, bits: u32) {
        if bits == 0 || self.limbs.is_empty() {
            return;
        }
        let limb_shift = (bits / 64) as usize;
        let bit_shift = bits % 64;
        if bit_shift == 0 {
            let mut next = vec![0; limb_shift];
            next.append(&mut self.limbs);
            self.limbs = next;
            return;
        }
        let mut next = vec![0_u64; self.limbs.len() + limb_shift + 1];
        for (index, limb) in self.limbs.iter().copied().enumerate() {
            next[index + limb_shift] |= limb << bit_shift;
            next[index + limb_shift + 1] |= limb >> (64 - bit_shift);
        }
        self.limbs = next;
        self.normalize();
    }

    fn shr_trunc(&mut self, bits: u32) {
        if bits == 0 {
            return;
        }
        let limb_shift = (bits / 64) as usize;
        if limb_shift >= self.limbs.len() {
            self.limbs.clear();
            return;
        }
        self.limbs.drain(..limb_shift);
        let bit_shift = bits % 64;
        if bit_shift == 0 {
            self.normalize();
            return;
        }
        let mut carry = 0_u64;
        for limb in self.limbs.iter_mut().rev() {
            let next = *limb << (64 - bit_shift);
            *limb = (*limb >> bit_shift) | carry;
            carry = next;
        }
        self.normalize();
    }

    fn bit(&self, index: u32) -> bool {
        let limb = (index / 64) as usize;
        let bit = index % 64;
        self.limbs
            .get(limb)
            .is_some_and(|value| (value & (1_u64 << bit)) != 0)
    }

    fn round_away(mut self, shift: u32) -> Self {
        if shift == 0 {
            return self;
        }
        let round_up = self.bit(shift - 1);
        self.shr_trunc(shift);
        if round_up {
            self.add_u64(1);
        }
        self
    }

    fn to_decimal(&self) -> String {
        if self.limbs.is_empty() {
            return "0".to_string();
        }
        let mut scratch = self.clone();
        let mut digits = Vec::new();
        while !scratch.limbs.is_empty() {
            let mut remainder = 0_u128;
            for limb in scratch.limbs.iter_mut().rev() {
                let current = (remainder << 64) | u128::from(*limb);
                *limb = (current / 10) as u64;
                remainder = current % 10;
            }
            scratch.normalize();
            let digit = u8::try_from(remainder).unwrap_or(0);
            digits.push(char::from(b'0' + digit));
        }
        digits.iter().rev().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::{number_to_locale_string, to_fixed};

    #[test]
    fn fixed_and_locale_shapes() {
        assert_eq!(to_fixed(0.35, 20.0).unwrap(), "0.34999999999999997780");
        assert_eq!(
            to_fixed(1.0, -1.0).unwrap_err().to_string(),
            "RangeError: toFixed() digits argument must be between 0 and 100"
        );
        assert_eq!(number_to_locale_string(-0.0), "-0");
        assert_eq!(number_to_locale_string(1234.5678), "1,234.568");
        assert_eq!(to_fixed(1000.0005, 3.0).unwrap(), "1000.000");
        assert_eq!(number_to_locale_string(1000.0005), "1,000.001");
        assert_eq!(number_to_locale_string(999.9995), "1,000");
        assert_eq!(number_to_locale_string(f64::INFINITY), "∞");
    }
}
