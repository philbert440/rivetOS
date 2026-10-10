use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct SkillBeforeContext {
    pub skill_name: String,
    pub skill_location: String,
    pub matched_triggers: Vec<String>,
    pub match_score: f64,
    pub skip: bool,
    pub skip_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SkillAfterContext {
    pub skill_name: String,
    pub success: bool,
    pub tools_used: Vec<String>,
    pub iterations: u32,
    pub duration_ms: u128,
}

type BeforeHandler = Arc<dyn Fn(&mut SkillBeforeContext) -> Result<(), String> + Send + Sync>;
type AfterHandler = Arc<dyn Fn(&SkillAfterContext) -> Result<(), String> + Send + Sync>;

struct BeforeHook {
    continue_on_error: bool,
    handler: BeforeHandler,
}

struct AfterHook {
    continue_on_error: bool,
    handler: AfterHandler,
}

#[derive(Default)]
pub struct SkillHookPipeline {
    before: Mutex<Vec<BeforeHook>>,
    after: Mutex<Vec<AfterHook>>,
}

impl SkillHookPipeline {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_before<F>(&self, continue_on_error: bool, handler: F)
    where
        F: Fn(&mut SkillBeforeContext) -> Result<(), String> + Send + Sync + 'static,
    {
        self.before
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(BeforeHook {
                continue_on_error,
                handler: Arc::new(handler),
            });
    }

    pub fn on_after<F>(&self, continue_on_error: bool, handler: F)
    where
        F: Fn(&SkillAfterContext) -> Result<(), String> + Send + Sync + 'static,
    {
        self.after
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .push(AfterHook {
                continue_on_error,
                handler: Arc::new(handler),
            });
    }

    pub fn run_before(&self, ctx: &mut SkillBeforeContext) -> Result<(), String> {
        let hooks = self
            .before
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .map(|hook| (hook.continue_on_error, Arc::clone(&hook.handler)))
            .collect::<Vec<_>>();
        for (continue_on_error, handler) in hooks {
            if let Err(err) = handler(ctx)
                && !continue_on_error
            {
                return Err(err);
            }
        }
        Ok(())
    }

    pub fn run_after(&self, ctx: &SkillAfterContext) -> Result<(), String> {
        let hooks = self
            .after
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .iter()
            .map(|hook| (hook.continue_on_error, Arc::clone(&hook.handler)))
            .collect::<Vec<_>>();
        for (continue_on_error, handler) in hooks {
            if let Err(err) = handler(ctx)
                && !continue_on_error
            {
                return Err(err);
            }
        }
        Ok(())
    }
}
