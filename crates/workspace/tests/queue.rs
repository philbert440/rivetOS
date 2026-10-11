use std::sync::Arc;

use parking_lot::Mutex;

use protocol::{InboundMessage, JsNumber};
use tokio::sync::Notify;
use workspace::{Intake, MessageQueue, is_command, parse_command};

fn message(text: &str) -> InboundMessage {
    InboundMessage {
        id: "1".to_string(),
        user_id: "user-1".to_string(),
        username: None,
        display_name: None,
        channel_id: "chan-1".to_string(),
        chat_type: "private".to_string(),
        text: text.to_string(),
        platform: "test".to_string(),
        agent: None,
        reply_to_message_id: None,
        attachments: None,
        metadata: None,
        timestamp: JsNumber::from(0_i64),
    }
}

fn queue_with(processed: &Arc<Mutex<Vec<String>>>) -> MessageQueue {
    let queue = MessageQueue::new();
    let seen = Arc::clone(processed);
    queue.set_handler(move |message| {
        let seen = Arc::clone(&seen);
        async move {
            seen.lock().push(message.text);
        }
    });
    queue
}

#[tokio::test]
async fn processes_immediately_when_idle() {
    let processed = Arc::new(Mutex::new(Vec::new()));
    let queue = queue_with(&processed);
    queue.enqueue(message("hello")).await;
    assert_eq!(processed.lock().as_slice(), ["hello"]);
    assert!(!queue.is_processing());
    assert_eq!(queue.depth(), 0);
}

#[tokio::test]
async fn commands_are_queued_like_any_other_message() {
    let processed = Arc::new(Mutex::new(Vec::new()));
    let queue = queue_with(&processed);
    queue.enqueue(message("/stop")).await;
    assert_eq!(processed.lock().as_slice(), ["/stop"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn queues_a_message_that_arrives_during_a_turn() {
    let queue = Arc::new(MessageQueue::new());
    let order = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let order = Arc::clone(&order);
        let started = Arc::clone(&started);
        let release = Arc::clone(&release);
        queue.set_handler(move |message| {
            let order = Arc::clone(&order);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                order.lock().push(format!("start:{}", message.text));
                if message.text == "first" {
                    started.notify_one();
                    release.notified().await;
                }
                order.lock().push(format!("end:{}", message.text));
            }
        });
    }

    let first = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move {
            queue.enqueue(message("first")).await;
        })
    };
    started.notified().await;
    assert!(queue.is_processing());
    queue.enqueue(message("second")).await;
    assert_eq!(queue.depth(), 1);
    release.notify_one();
    first.await.unwrap();

    assert_eq!(
        order.lock().as_slice(),
        ["start:first", "end:first", "start:second", "end:second"]
    );
    assert_eq!(queue.depth(), 0);
    assert!(!queue.is_processing());
}

#[tokio::test]
async fn depth_clear_and_turn_markers_match_the_queue_tests() {
    let processed = Arc::new(Mutex::new(Vec::new()));
    let queue = queue_with(&processed);
    assert_eq!(queue.depth(), 0);

    queue.begin_turn();
    assert!(queue.is_processing());
    queue.enqueue(message("queued-1")).await;
    queue.enqueue(message("queued-2")).await;
    assert_eq!(queue.depth(), 2);
    queue.clear();
    assert_eq!(queue.depth(), 0);
    queue.end_turn().await;
    assert!(processed.lock().is_empty());

    queue.begin_turn();
    queue.enqueue(message("during-turn")).await;
    assert!(processed.lock().is_empty());
    assert_eq!(queue.depth(), 1);
    queue.end_turn().await;
    assert_eq!(processed.lock().as_slice(), ["during-turn"]);
    assert_eq!(queue.depth(), 0);
    assert!(!queue.is_processing());
}

#[tokio::test]
async fn enqueue_without_a_handler_drops_the_message() {
    let queue = MessageQueue::new();
    queue.enqueue(message("lost")).await;
    assert_eq!(queue.depth(), 0);
    assert!(!queue.is_processing());
}

#[test]
fn is_command_recognizes_the_registry_and_rejects_the_rest() {
    for name in [
        "/stop",
        "/interrupt",
        "/steer some message",
        "/new",
        "/status",
        "/model",
        "/think",
        "/reasoning",
        "/tools",
        "/context",
        "/memory",
        "/clear",
        "/start",
        "/help",
    ] {
        assert!(is_command(name), "{name}");
    }
    for name in ["hello", "/unknown", "/", "", "stop", "/Stop", "/ steer"] {
        assert!(!is_command(name), "{name}");
    }
}

#[test]
fn parse_command_keeps_trailing_space_and_collapses_separators() {
    let parsed = parse_command("/steer go faster").unwrap();
    assert_eq!(parsed.command, "steer");
    assert_eq!(parsed.args, "go faster");

    let trailing = parse_command("/steer go faster ").unwrap();
    assert_eq!(trailing.args, "go faster ");

    let collapsed = parse_command("/model   xai   grok").unwrap();
    assert_eq!(collapsed.command, "model");
    assert_eq!(collapsed.args, "xai grok");

    let stop = parse_command("/stop").unwrap();
    assert_eq!(stop.command, "stop");
    assert_eq!(stop.args, "");

    assert!(parse_command("hello").is_none());
    assert!(parse_command("/badcommand").is_none());
    assert!(parse_command("/").is_none());
}

async fn wait_until_drained(queue: &MessageQueue, order: &Mutex<Vec<String>>, expected: &str) {
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        let seen = order.lock().clone();
        if !queue.is_processing() && queue.depth() == 0 && seen.iter().any(|text| text == expected)
        {
            return;
        }
        let processing = queue.is_processing();
        let depth = queue.depth();
        if !processing && depth > 0 {
            panic!("processing cleared while {depth} messages were still queued seen={seen:?}");
        }
        if tokio::time::Instant::now() >= deadline {
            panic!("queue stayed wedged processing={processing} depth={depth} seen={seen:?}");
        }
        tokio::task::yield_now().await;
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn aborting_a_handler_clears_processing_and_drains() {
    let queue = Arc::new(MessageQueue::new());
    let order = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let order = Arc::clone(&order);
        let started = Arc::clone(&started);
        let release = Arc::clone(&release);
        queue.set_handler(move |message| {
            let order = Arc::clone(&order);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                order.lock().push(message.text.clone());
                if message.text == "first" {
                    started.notify_one();
                    release.notified().await;
                }
            }
        });
    }
    let running = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move {
            queue.enqueue(message("first")).await;
        })
    };
    started.notified().await;
    assert!(queue.is_processing());
    queue.enqueue(message("second")).await;
    assert_eq!(queue.depth(), 1);
    running.abort();
    wait_until_drained(&queue, &order, "second").await;
    assert!(!queue.is_processing());
    assert_eq!(queue.depth(), 0);
    assert!(order.lock().iter().any(|text| text == "second"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_panicking_handler_clears_processing_and_drains() {
    let queue = Arc::new(MessageQueue::new());
    let order = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let order = Arc::clone(&order);
        let started = Arc::clone(&started);
        let release = Arc::clone(&release);
        queue.set_handler(move |message| {
            let order = Arc::clone(&order);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                if message.text == "first" {
                    started.notify_one();
                    release.notified().await;
                    panic!("handler boom");
                }
                order.lock().push(message.text);
            }
        });
    }
    let running = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move {
            queue.enqueue(message("first")).await;
        })
    };
    started.notified().await;
    queue.enqueue(message("second")).await;
    assert_eq!(queue.depth(), 1);
    release.notify_one();
    let joined = running.await;
    assert!(joined.is_err());
    wait_until_drained(&queue, &order, "second").await;
    assert!(!queue.is_processing());
    assert_eq!(queue.depth(), 0);
    assert_eq!(order.lock().as_slice(), ["second"]);
}

#[tokio::test]
async fn a_large_backlog_drains_in_order() {
    const N: usize = 4_096;
    let order = Arc::new(Mutex::new(Vec::new()));
    let queue = MessageQueue::new();
    let seen = Arc::clone(&order);
    queue.set_handler(move |message| {
        let seen = Arc::clone(&seen);
        async move {
            tokio::task::yield_now().await;
            seen.lock().push(message.text);
        }
    });
    queue.begin_turn();
    for i in 0..N {
        queue.enqueue(message(&format!("{i}"))).await;
    }
    assert_eq!(queue.depth(), N);
    assert!(order.lock().is_empty());
    queue.end_turn().await;
    let seen = order.lock().clone();
    assert_eq!(seen.len(), N);
    for (i, text) in seen.iter().enumerate() {
        assert_eq!(text, &i.to_string());
    }
    assert!(!queue.is_processing());
    assert_eq!(queue.depth(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_after_many_completions_keeps_fifo() {
    const DONE: usize = 300;
    const TAIL: usize = 40;
    const LATE: usize = 16;
    let queue = Arc::new(MessageQueue::new());
    let order = Arc::new(Mutex::new(Vec::new()));
    let started = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    {
        let order = Arc::clone(&order);
        let started = Arc::clone(&started);
        let release = Arc::clone(&release);
        queue.set_handler(move |message| {
            let order = Arc::clone(&order);
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            async move {
                tokio::task::yield_now().await;
                order.lock().push(message.text.clone());
                if message.text == "block" {
                    started.notify_one();
                    release.notified().await;
                }
            }
        });
    }
    queue.begin_turn();
    for i in 0..DONE {
        queue.enqueue(message(&format!("m{i:04}"))).await;
    }
    queue.enqueue(message("block")).await;
    for i in 0..TAIL {
        queue.enqueue(message(&format!("t{i:04}"))).await;
    }
    assert_eq!(queue.depth(), DONE + 1 + TAIL);
    let running = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move {
            queue.end_turn().await;
        })
    };
    started.notified().await;
    running.abort();
    let late = {
        let queue = Arc::clone(&queue);
        tokio::spawn(async move {
            for i in 0..LATE {
                queue.enqueue(message(&format!("c{i:04}"))).await;
            }
        })
    };
    late.await.unwrap();
    wait_until_drained(&queue, &order, "c0015").await;
    let mut expected = Vec::new();
    for i in 0..DONE {
        expected.push(format!("m{i:04}"));
    }
    expected.push("block".to_string());
    for i in 0..TAIL {
        expected.push(format!("t{i:04}"));
    }
    for i in 0..LATE {
        expected.push(format!("c{i:04}"));
    }
    assert_eq!(order.lock().as_slice(), expected.as_slice());
    assert!(!queue.is_processing());
    assert_eq!(queue.depth(), 0);
}

#[test]
fn accept_returns_a_command_without_enqueueing() {
    match MessageQueue::accept(&message("/steer go faster ")) {
        Intake::Command(parsed) => {
            assert_eq!(parsed.command, "steer");
            assert_eq!(parsed.args, "go faster ");
        }
        Intake::Message(_) => panic!("command"),
    }
    match MessageQueue::accept(&message("hello")) {
        Intake::Message(message) => assert_eq!(message.text, "hello"),
        Intake::Command(_) => panic!("message"),
    }
}
