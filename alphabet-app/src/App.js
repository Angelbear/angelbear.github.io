import React, { Component } from 'react';
import './App.css';

class App extends Component {
  constructor() {
    super();
    this.state = {
      letters: []
    };
  }

  shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  componentDidMount() {
    const letters = 'abcdefghijklmnopqrstuvwxyz'.split('');
    const shuffledLetters = this.shuffle(letters);
    const randomCaseLetters = shuffledLetters.map(letter => {
      return Math.random() > 0.5 ? letter.toUpperCase() : letter;
    });
    this.setState({ letters: randomCaseLetters });
  }

  render() {
    return (
      <div className="container">
        <h1>Random Alphabets Table</h1>
        <div className="letters-grid">
          {this.state.letters.map((letter, index) => {
            if (letter === letter.toLowerCase()) {
              return (
                <div key={index} className="letter-container">
                  <div className="rectangle"></div>
                  <span className="letter">{letter}</span>
                </div>
              );
            } else {
              return (
                <div key={index} className="letter-container">
                  <span className="letter">{letter}</span>
                  <div className="rectangle"></div>
                </div>
              );
            }
          })}
        </div>
      </div>
    );
  }
}

export default App;