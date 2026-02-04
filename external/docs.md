# Stock trading web application
## Functional Requirements:
1. User Management
- 1.1 Create account: The system shall allow users to create an account using an email address and password.
- 1.2 Authenticate user: The system shall allow users to log in and log out using valid credentials.
- 1.3 Secure passwords: The system shall securely hash and store user passwords.
- 1.4 Prevent duplicates: The system shall prevent registration with duplicate email addresses.

2. Wallet Management
- 2.1 Provision wallet: The system shall automatically create exactly one cash wallet for each user upon user account creation, with an initial balance of 1,000 units.
- 2.2 Deposit funds: The system shall allow users to deposit cash into their wallet, using the payment service.
- 2.3 Retrieve balance: The system shall allow users to view their current wallet balance.
- 2.4 Prevent overdraft: The system shall prevent wallet balances from becoming negative.
- 2.5 Record wallet transactions: The system shall record each wallet balance change with an amount and timestamp.

3. Payment Service
- 3.1 Simulate payment: The system shall provide a payment service that simulates successful and failed payment transactions without processing real monetary funds.
- 3.2 Enter payment details: The system shall allow users to enter a credit card number and CVC for payment simulation.
- 3.3 Validate payment method: The system shall validate payment requests using Luhn’s algorithm, where a 16-digit card number that passes the Luhn checksum is considered a valid fake card.
- 3.4 Record transaction: The system shall record each simulated payment transaction with status and amount.

4. Market Data
- 4.1 Simulate market data: The system shall provide simulated real-time stock price data for exactly six predefined stock symbols, where prices update continuously based on internal simulation logic.

5. Order Management
- 4.1 Place orders: The system shall allow users to place buy and sell stock orders.
- 4.2 Validate resources: The system shall validate sufficient cash for buy orders and sufficient shares for sell orders.
- 4.3 Execute trades: The system shall execute orders immediately using the current simulated market price.
- 4.4 Execute order: The system shall execute orders immediately using the current simulated market price.
- 4.5 Update balances: The system shall update the user’s wallet balance and stock holdings upon successful order execution.
- 4.6 Record orders: The system shall record each order with symbol, side, quantity, execution price, and timestamp.

6. Portfolio Management
- 6.1 View holdings: The system shall allow users to view their current stock holdings by symbol and quantity.
- 6.2 Portfolio valuation: The system shall calculate the current portfolio value using simulated real-time market prices.
- 6.3 Position breakdown: The system shall display each holding’s current price and total value.

7. User Interface
- 7.1 Login page: The system shall provide a login page with email and password input fields, and upon successful authentication, redirect the user to the dashboard page.
- 7.2 Registration page: The system shall provide a registration page that allows users to create an account using an email address and password.
- 7.3 Dashboard page: The system shall provide a dashboard page that displays the user’s wallet balance and current portfolio summary.
- 7.4 Deposit page: The system shall provide a deposit page that allows users to enter payment details and deposit funds into their wallet using the payment service.
- 7.5 Trading page: The system shall provide a trading page that displays simulated real-time stock prices and allows users to place buy and sell orders for supported symbols.
- 7.6 Portfolio page: The system shall provide a portfolio page that displays the user’s current holdings, position values, and total portfolio value.


## System Constraints
- The frontend, backend, and database shall each be containerized using Docker.
- The frontend shall be implemented using Next.js with React and TypeScript and shall run on localhost:3000.
- The backend shall be implmented using FastAPI and shall run on localhost:8000
- The backend shall use SQLAlchemy ORM to define and manage database schemas and mappings.
- The database shall run locally using PostgreSQL on localhost:5432.
- The system shall not employ external APIs for the payment service.


## API Specification
- POST /api/register: Create user + wallet (1000 initial balance)
- POST /api/login: Return JWT token
- GET /api/wallet: Return balance + transactions
- POST /api/wallet/deposit: Validate card (Luhn), simulate payment, credit wallet
- GET /api/market/prices:  Return current simulated prices for 6 stocks
- POST /api/orders: Place buy/sell order, validate funds/shares, execute immediately
- GET /api/portfolio: Return holdings with current prices and values


## Data Model                                                                                           
- User: id, email (unique), hashed_password, created_at                                                              
- Wallet: id, user_id (FK, unique), balance (Numeric, default=1000)                                                  
- WalletTransaction: id, wallet_id (FK), amount, timestamp                                                           
- Payment: id, user_id (FK), amount, status, timestamp                                                               
- Order: id, user_id (FK), symbol, side (buy/sell), quantity, price, timestamp                                       
- Holding: id, user_id (FK), symbol, quantity (unique constraint on user_id+symbol)
