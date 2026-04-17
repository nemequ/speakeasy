use crate::{Command, Event};
use anyhow::Result;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event as CrossEvent, KeyCode},
    execute,
    terminal::{disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen},
};
use ratatui::{
    backend::CrosstermBackend,
    layout::{Constraint, Direction, Layout},
    style::{Color, Style},
    widgets::{Block, Borders, Gauge, Paragraph},
    Terminal,
};
use std::io;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub struct TuiState {
    pub status: String,
    pub transcription: String,
    pub level: f64,
    pub recording: bool,
}

pub async fn run_tui(
    mut event_rx: mpsc::UnboundedReceiver<Event>,
    cmd_tx: mpsc::UnboundedSender<Command>,
) -> Result<()> {
    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let state = Arc::new(Mutex::new(TuiState {
        status: "Idle".to_string(),
        transcription: "".to_string(),
        level: 0.0,
        recording: false,
    }));

    let state_ui = Arc::clone(&state);
    
    // Spawn event handler task
    tokio::spawn(async move {
        while let Some(event) = event_rx.recv().await {
            let mut s = state.lock().unwrap();
            match event {
                Event::Ready => s.status = "Ready".to_string(),
                Event::Level { rms, peak: _ } => {
                    s.level = rms;
                }
                Event::Partial { text } => {
                    s.transcription = text;
                    s.status = "Recording... (partial)".to_string();
                }
                Event::Transcribing => {
                    s.status = "Transcribing...".to_string();
                    s.level = 0.0;
                }
                Event::Stopped { text } => {
                    s.transcription = text;
                    s.status = "Idle".to_string();
                    s.recording = false;
                    s.level = 0.0;
                }
                Event::Final { text } => {
                    s.transcription = text;
                    s.status = "AI Cleaned".to_string();
                }
                Event::Delta { text } => {
                    // Stream AI-cleanup chunks into the TUI view as
                    // they arrive so the user sees progress instead
                    // of a jump from raw STT to cleaned text. The
                    // first delta in a cleanup pass replaces the
                    // raw-STT text that Stopped left in the view.
                    if s.status != "AI Cleaning..." {
                        s.transcription.clear();
                        s.status = "AI Cleaning...".to_string();
                    }
                    s.transcription.push_str(&text);
                }
                Event::Error { message } => {
                    s.status = format!("Error: {}", message);
                }
            }
        }
    });

    loop {
        terminal.draw(|f| {
            let chunks = Layout::default()
                .direction(Direction::Vertical)
                .margin(1)
                .constraints(
                    [
                        Constraint::Length(3),
                        Constraint::Length(3),
                        Constraint::Min(5),
                        Constraint::Length(1),
                    ]
                    .as_ref(),
                )
                .split(f.size());

            let s = state_ui.lock().unwrap();

            // Status
            let status = Paragraph::new(s.status.clone())
                .block(Block::default().title("Status").borders(Borders::ALL));
            f.render_widget(status, chunks[0]);

            // VU Meter (Gauge)
            // Scale level slightly for visibility (rms is usually 0.0 to 0.5)
            let percent = (s.level * 200.0).min(100.0).max(0.0) as u16;
            let gauge = Gauge::default()
                .block(Block::default().title("Microphone Level").borders(Borders::ALL))
                .gauge_style(Style::default().fg(Color::Green))
                .percent(percent);
            f.render_widget(gauge, chunks[1]);

            // Transcription
            let transcription = Paragraph::new(s.transcription.clone())
                .block(Block::default().title("Latest Transcription").borders(Borders::ALL))
                .wrap(ratatui::widgets::Wrap { trim: true });
            f.render_widget(transcription, chunks[2]);

            // Help
            let help = Paragraph::new("Space: toggle recording | Q: quit");
            f.render_widget(help, chunks[3]);
        })?;

        if event::poll(std::time::Duration::from_millis(50))? {
            if let CrossEvent::Key(key) = event::read()? {
                match key.code {
                    KeyCode::Char('q') => break,
                    KeyCode::Char(' ') => {
                        let mut s = state_ui.lock().unwrap();
                        if s.recording {
                            s.recording = false;
                            s.status = "Transcribing...".to_string();
                            let _ = cmd_tx.send(Command { cmd: "stop".to_string() });
                        } else {
                            s.recording = true;
                            s.status = "Recording...".to_string();
                            let _ = cmd_tx.send(Command { cmd: "start".to_string() });
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    Ok(())
}
