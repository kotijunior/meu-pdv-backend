const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken'); // <-- NOVA LINHA
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Configuração do nosso Banco de Dados Nuvem
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Necessário para conexões seguras na nuvem
  }
});

// Rota de teste para ver se o servidor está rodando
app.get('/api/status', (req, res) => {
  res.json({ message: 'PDV Back-end operando com sucesso!' });
});

// Nova rota para testar o Banco de Dados
app.get('/api/db-test', async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query('SELECT NOW() as data_hora_banco');
    client.release();
    res.json({ 
      message: 'Conexão com o Supabase foi um sucesso!', 
      dataHoraNuvem: result.rows[0].data_hora_banco 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao conectar no banco', detalhe: err.message });
  }
});

// Rota para cadastrar um novo produto
app.post('/api/products', async (req, res) => {
  const { name, barcode, cost_price, sale_price, stock_quantity, category } = req.body;
  
  try {
    const query = `
      INSERT INTO products (name, barcode, cost_price, sale_price, stock_quantity, category)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;
    `;
    const values = [name, barcode, cost_price, sale_price, stock_quantity, category];
    
    const result = await pool.query(query, values);
    res.status(201).json({
      message: 'Produto cadastrado com sucesso!',
      product: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao cadastrar produto', detalhe: err.message });
  }
});

// Rota para registrar uma venda e abater o estoque
app.post('/api/sales', async (req, res) => {
  const { items, payment_method, total_amount } = req.body; 
  // items deve ser um array exato contendo: [{ product_id, quantity, unit_price }]

  const client = await pool.connect();

  try {
    // Inicia uma transação segura (como uma conta contábil: se algo falhar, nada é gravado pela metade)
    await client.query('BEGIN');

    // 1. Cria a venda principal
    const saleQuery = `
      INSERT INTO sales (total_amount, payment_method, status)
      VALUES ($1, $2, 'completed')
      RETURNING id, created_at;
    `;
    const saleResult = await client.query(saleQuery, [total_amount, payment_method]);
    const saleId = saleResult.rows[0].id;

    // 2. Processa cada item vendido (insere no histórico e abate o estoque)
    for (const item of items) {
      // Insere o item na tabela de itens da venda
      const itemQuery = `
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
        VALUES ($1, $2, $3, $4, $5);
      `;
      const subtotal = item.quantity * item.unit_price;
      await client.query(itemQuery, [saleId, item.product_id, item.quantity, item.unit_price, subtotal]);

      // Abate rigorosamente a quantidade do estoque do produto
      const stockQuery = `
        UPDATE products 
        SET stock_quantity = stock_quantity - $1 
        WHERE id = $2;
      `;
      await client.query(stockQuery, [item.quantity, item.product_id]);
    }

    // Confirma a operação no banco de dados
    await client.query('COMMIT');
    client.release();

    res.status(201).json({
      message: 'Venda realizada com sucesso e estoque atualizado!',
      saleId: saleId
    });

  } catch (err) {
    // Se houver qualquer erro, desfaz todas as alterações para proteger os dados
    await client.query('ROLLBACK');
    client.release();
    console.error(err);
    res.status(500).json({ error: 'Erro ao processar a venda', detalhe: err.message });
  }
});

// Abrir um novo caixa (informando o fundo de troco)
app.post('/api/cash/open', async (req, res) => {
  const { opening_balance } = req.body;
  try {
    const query = `
      INSERT INTO cash_registers (opening_balance, status)
      VALUES ($1, 'open')
      RETURNING *;
    `;
    const result = await pool.query(query, [opening_balance]);
    res.status(201).json({ message: 'Caixa aberto com sucesso!', cashRegister: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao abrir o caixa', detalhe: err.message });
  }
});

// Fechar o caixa (informando o valor apurado na gaveta)
app.post('/api/cash/close/:id', async (req, res) => {
  const { id } = req.params;
  const { closing_balance } = req.body;
  try {
    const query = `
      UPDATE cash_registers 
      SET closing_balance = $1, status = 'closed', closed_at = timezone('utc', now())
      WHERE id = $2 
      RETURNING *;
    `;
    const result = await pool.query(query, [closing_balance, id]);
    res.status(200).json({ message: 'Caixa fechado com sucesso!', cashRegister: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao fechar o caixa', detalhe: err.message });
  }
});

// Rota para puxar o resumo gerencial do dia
app.get('/api/reports/summary', async (req, res) => {
  try {
    const salesResult = await pool.query('SELECT COUNT(*) as total_vendas, COALESCE(SUM(total_amount), 0) as faturamento_total FROM sales');
    const productsResult = await pool.query('SELECT COUNT(*) as total_produtos, COALESCE(SUM(stock_quantity), 0) as itens_estoque FROM products');

    res.json({
      totalVendas: salesResult.rows[0].total_vendas,
      faturamentoTotal: parseFloat(salesResult.rows[0].faturamento_total),
      totalProdutosCadastrados: productsResult.rows[0].total_produtos,
      totalItensEstoque: productsResult.rows[0].itens_estoque
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar relatório', detalhe: err.message });
  }
});

// Rota de Login com JWT
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuário não encontrado!' });
    }

    const user = result.rows[0];
    
    if (user.password_hash !== password) {
      return res.status(401).json({ error: 'Senha incorreta!' });
    }

    // MÁGICA DO JWT: Gera um crachá digital criptografado
    const token = jwt.sign(
      { id: user.id, name: user.name, role: user.role },
      process.env.JWT_SECRET || 'chave_mestra_secreta_pdv_2026',
      { expiresIn: '8h' } // O turno dura 8 horas
    );

    res.json({ 
      message: 'Login realizado com sucesso!', 
      user: { id: user.id, name: user.name, role: user.role },
      token: token // Enviamos o token de volta para a Vitrine
    });
  } catch (err) {
    res.status(500).json({ error: 'Erro no servidor ao tentar logar', detalhe: err.message });
  }
});

// Rota para procurar produto pelo código de barras
app.get('/api/products/barcode/:barcode', async (req, res) => {
  const { barcode } = req.params;
  try {
    const result = await pool.query('SELECT * FROM products WHERE barcode = $1', [barcode]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Produto não encontrado' });
    }
    
    // Devolve o produto encontrado
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Erro ao buscar produto', detalhe: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});