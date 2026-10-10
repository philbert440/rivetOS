use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("unknown {kind} value: {value}")]
pub struct UnknownWireValue {
    pub kind: &'static str,
    pub value: String,
}

#[macro_export]
macro_rules! wire_enum {
    (
        $vis:vis enum $name:ident {
            $($variant:ident => $wire:literal),* $(,)?
        }
    ) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        $vis enum $name {
            $($variant),*
        }

        impl $name {
            pub const ALL: [Self; {
                const VARIANTS: &[&str] = &[$(stringify!($variant)),*];
                VARIANTS.len()
            }] = [$(Self::$variant),*];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $wire),*
                }
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                formatter.write_str(self.as_str())
            }
        }

        impl ::std::str::FromStr for $name {
            type Err = $crate::UnknownWireValue;

            fn from_str(text: &str) -> ::std::result::Result<Self, Self::Err> {
                match text {
                    $($wire => ::std::result::Result::Ok(Self::$variant),)*
                    _ => ::std::result::Result::Err($crate::UnknownWireValue {
                        kind: stringify!($name),
                        value: text.to_owned(),
                    }),
                }
            }
        }

        impl ::serde::Serialize for $name {
            fn serialize<S>(&self, serializer: S) -> ::std::result::Result<S::Ok, S::Error>
            where
                S: ::serde::Serializer,
            {
                serializer.serialize_str(self.as_str())
            }
        }

        impl<'de> ::serde::Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> ::std::result::Result<Self, D::Error>
            where
                D: ::serde::Deserializer<'de>,
            {
                let text = <String as ::serde::Deserialize>::deserialize(deserializer)?;
                <Self as ::std::str::FromStr>::from_str(&text).map_err(::serde::de::Error::custom)
            }
        }
    };
}
