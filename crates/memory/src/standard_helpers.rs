#[derive(Clone)]
struct Big {
    limbs: Vec<u64>,
}

impl Big {
    fn zero() -> Self {
        Self { limbs: Vec::new() }
    }

    fn from_u128(n: u128) -> Self {
        if n == 0 {
            return Self::zero();
        }
        let lo = n as u64;
        let hi = (n >> 64) as u64;
        if hi == 0 {
            Self { limbs: vec![lo] }
        } else {
            Self {
                limbs: vec![lo, hi],
            }
        }
    }

    fn is_zero(&self) -> bool {
        self.limbs.is_empty()
    }

    fn trim(&mut self) {
        while self.limbs.last() == Some(&0) {
            self.limbs.pop();
        }
    }

    fn mul_small(&mut self, m: u64) {
        if m == 0 || self.is_zero() {
            self.limbs.clear();
            return;
        }
        let mut carry = 0u128;
        for limb in &mut self.limbs {
            let prod = u128::from(*limb) * u128::from(m) + carry;
            *limb = prod as u64;
            carry = prod >> 64;
        }
        if carry > 0 {
            self.limbs.push(carry as u64);
        }
    }

    fn add_small(&mut self, n: u64) {
        if n == 0 {
            return;
        }
        if self.limbs.is_empty() {
            self.limbs.push(n);
            return;
        }
        let mut carry = u128::from(n);
        for limb in &mut self.limbs {
            let sum = u128::from(*limb) + carry;
            *limb = sum as u64;
            carry = sum >> 64;
            if carry == 0 {
                return;
            }
        }
        if carry > 0 {
            self.limbs.push(carry as u64);
        }
    }

    fn bit(&self, index: u32) -> bool {
        let word = (index / 64) as usize;
        let bit = index % 64;
        self.limbs
            .get(word)
            .is_some_and(|limb| ((limb >> bit) & 1) == 1)
    }

    fn shl_bits(&mut self, bits: u32) {
        if bits == 0 || self.is_zero() {
            return;
        }
        let words = (bits / 64) as usize;
        let rem = bits % 64;
        if rem != 0 {
            let mut carry = 0u64;
            for limb in &mut self.limbs {
                let next = *limb >> (64 - rem);
                *limb = (*limb << rem) | carry;
                carry = next;
            }
            if carry > 0 {
                self.limbs.push(carry);
            }
        }
        if words > 0 {
            let mut next = vec![0; words];
            next.append(&mut self.limbs);
            self.limbs = next;
        }
    }

    fn shr_bits(&mut self, bits: u32) {
        if bits == 0 || self.is_zero() {
            return;
        }
        let words = (bits / 64) as usize;
        if words >= self.limbs.len() {
            self.limbs.clear();
            return;
        }
        self.limbs.drain(0..words);
        let rem = bits % 64;
        if rem == 0 {
            self.trim();
            return;
        }
        let mut carry = 0u64;
        for limb in self.limbs.iter_mut().rev() {
            let next = *limb << (64 - rem);
            *limb = (*limb >> rem) | carry;
            carry = next;
        }
        self.trim();
    }

    fn shr_round_half_away(&mut self, bits: u32) {
        if bits == 0 || self.is_zero() {
            return;
        }
        let round_up = self.bit(bits - 1);
        self.shr_bits(bits);
        if round_up {
            self.add_small(1);
        }
    }

    fn to_dec(&self) -> String {
        if self.is_zero() {
            return "0".to_string();
        }
        let mut n = self.clone();
        let mut chars = Vec::new();
        while !n.is_zero() {
            let rem = n.div_small(10);
            chars.push(char::from(b'0' + rem as u8));
        }
        chars.iter().rev().collect()
    }

    fn div_small(&mut self, divisor: u64) -> u64 {
        let mut rem = 0u128;
        for limb in self.limbs.iter_mut().rev() {
            let cur = (rem << 64) | u128::from(*limb);
            *limb = (cur / u128::from(divisor)) as u64;
            rem = cur % u128::from(divisor);
        }
        self.trim();
        rem as u64
    }
}

fn mant_exp(value: f64) -> (u128, i32) {
    let bits = value.to_bits();
    let exp_field = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & ((1u64 << 52) - 1);
    if exp_field == 0 {
        (u128::from(frac), 1 - 1023 - 52)
    } else {
        (u128::from(frac | (1u64 << 52)), exp_field - 1023 - 52)
    }
}

fn fixed_digits(abs: f64, digits: u32) -> String {
    if abs == 0.0 {
        return "0".to_string();
    }
    let (mant, power) = mant_exp(abs);
    if mant == 0 {
        return "0".to_string();
    }
    let mut n = Big::from_u128(mant);
    for _ in 0..digits {
        n.mul_small(10);
    }
    if power >= 0 {
        n.shl_bits(power as u32);
    } else {
        n.shr_round_half_away((-power) as u32);
    }
    n.to_dec()
}

fn js_large_number(abs: f64) -> String {
    let (mant, power) = mant_exp(abs);
    let mut n = Big::from_u128(mant);
    if power > 0 {
        n.shl_bits(power as u32);
    }
    let digits = n.to_dec();
    let exp = digits.len() as i32 - 1;
    let trimmed = digits.trim_end_matches('0');
    let body = if trimmed.len() <= 1 {
        trimmed.to_string()
    } else {
        format!("{}.{}", &trimmed[..1], &trimmed[1..])
    };
    format!("{body}e+{exp}")
}

pub fn js_to_fixed(value: f64, digits: i32) -> Result<String, String> {
    if !(0..=100).contains(&digits) {
        return Err("RangeError: toFixed() digits argument must be between 0 and 100".to_string());
    }
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
    let sign = if value < 0.0 { "-" } else { "" };
    let abs = value.abs();
    if abs >= 1e21 {
        return Ok(format!("{sign}{}", js_large_number(abs)));
    }
    let digits = digits as u32;
    let raw = fixed_digits(abs, digits);
    if digits == 0 {
        return Ok(format!("{sign}{raw}"));
    }
    let mut padded = raw;
    while padded.len() <= digits as usize {
        padded.insert(0, '0');
    }
    let split = padded.len() - digits as usize;
    Ok(format!("{sign}{}.{}", &padded[..split], &padded[split..]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_fixed_matches_recorded_javascript() {
        assert_eq!(js_to_fixed(0.25, 0).unwrap(), "0");
        assert_eq!(js_to_fixed(0.25, 1).unwrap(), "0.3");
        assert_eq!(js_to_fixed(0.25, 2).unwrap(), "0.25");
        assert_eq!(js_to_fixed(0.25, 3).unwrap(), "0.250");
        assert_eq!(js_to_fixed(0.25, 20).unwrap(), "0.25000000000000000000");
        assert_eq!(js_to_fixed(0.35, 0).unwrap(), "0");
        assert_eq!(js_to_fixed(0.35, 1).unwrap(), "0.3");
        assert_eq!(js_to_fixed(0.35, 2).unwrap(), "0.35");
        assert_eq!(js_to_fixed(0.35, 3).unwrap(), "0.350");
        assert_eq!(js_to_fixed(0.35, 20).unwrap(), "0.34999999999999997780");
        assert_eq!(js_to_fixed(0.15, 20).unwrap(), "0.14999999999999999445");
        assert_eq!(js_to_fixed(0.05, 1).unwrap(), "0.1");
        assert_eq!(js_to_fixed(0.05, 20).unwrap(), "0.05000000000000000278");
        assert_eq!(
            js_to_fixed(999.995, 20).unwrap(),
            "999.99500000000000454747"
        );
        assert_eq!(js_to_fixed(0.42, 3).unwrap(), "0.420");
        assert_eq!(
            js_to_fixed(9007199254740992.0, 1).unwrap(),
            "9007199254740992.0"
        );
        assert_eq!(
            js_to_fixed(100000000000000000000.0, 2).unwrap(),
            "100000000000000000000.00"
        );
        assert_eq!(js_to_fixed(1e21, 2).unwrap(), "1e+21");
        assert_eq!(js_to_fixed(f64::INFINITY, 2).unwrap(), "Infinity");
        assert_eq!(js_to_fixed(f64::NEG_INFINITY, 2).unwrap(), "-Infinity");
        assert_eq!(js_to_fixed(f64::NAN, 2).unwrap(), "NaN");
        assert_eq!(js_to_fixed(-0.0, 1).unwrap(), "0.0");
        assert!(
            js_to_fixed(1.0, -1)
                .unwrap_err()
                .contains("between 0 and 100")
        );
        assert!(
            js_to_fixed(1.0, 101)
                .unwrap_err()
                .contains("between 0 and 100")
        );
    }
}
